const { getDb } = require('../db/database');
const githubApi = require('./githubApi');
const rateLimitTracker = require('./rateLimitTracker');

// Failure resolution for headless digests (#11): given failures reported by
// GitHub's notification emails, say which are still outstanding.
//
// Safety rule: a failure is only ever reported resolved on evidence. Evidence
// is a completed run with conclusion `success`, or a closed pull request read
// from GitHub. Anything missing, unreadable or contradictory answers
// `still_failing` or `unknown`, both of which keep the failure in the digest.

const PR_EVENTS = ['pull_request', 'pull_request_target'];
// Completed conclusions that say nothing about the code, as in #7.
const SKIPPED_CONCLUSIONS = ['cancelled', 'skipped', 'neutral'];
const FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

const OUTSTANDING_REASONS = new Set(['still_failing', 'unknown']);

const GITHUB_TIMEOUT_MS = 3000;
const NOT_A_TAG_TTL_MS = 24 * 60 * 60 * 1000;
const PR_CLOSED_TTL_MS = 6 * 60 * 60 * 1000;
const PR_OPEN_TTL_MS = 10 * 60 * 1000;
const MAX_TAG_CANDIDATES = 5;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const MAX_TEXT_LENGTH = 500;

function result(reason, run) {
  const out = { outstanding: OUTSTANDING_REASONS.has(reason), reason };
  if (run) {
    out.latestRun = {
      id: run.id,
      conclusion: run.conclusion || null,
      headSha: run.head_sha || null,
      completedAt: run.status === 'completed' ? run.updated_at : null,
      url: run.html_url || null,
    };
  }
  return out;
}

/** Normalise one input entry, or return null if it is malformed. */
function normalise(input) {
  if (!input || typeof input !== 'object') return null;
  const { repo, workflow, ref, sha, kind } = input;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null;
  if (typeof workflow !== 'string' || !workflow || workflow.length > MAX_TEXT_LENGTH) return null;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha.toLowerCase())) return null;
  if (kind !== 'push' && kind !== 'pr') return null;
  if (kind === 'push' && (typeof ref !== 'string' || !ref || ref.length > MAX_TEXT_LENGTH)) return null;
  const attempt = input.attempt === undefined ? 1 : input.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  const [owner, name] = repo.split('/');
  return { owner, name, workflow, ref, sha: sha.toLowerCase(), kind, attempt };
}

/** The watched, visible repo matching owner/name, using GAV's own spelling. */
function findRepo(db, owner, name) {
  return db
    .prepare(
      `SELECT owner, name FROM repos
       WHERE owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE AND hidden = 0`
    )
    .get(owner, name);
}

function eventFamilySql(kind) {
  const list = PR_EVENTS.map(e => `'${e}'`).join(', ');
  return kind === 'pr' ? `event IN (${list})` : `(event IS NULL OR event NOT IN (${list}))`;
}

/** Rule 1: the run the email is about. */
function findFailedRun(db, repo, f) {
  const rows = db
    .prepare(
      `SELECT * FROM workflow_runs
       WHERE owner_name = @owner AND repo_name = @name
         AND head_sha >= @sha AND head_sha < @shaEnd
         AND workflow_name = @workflow
         AND ${eventFamilySql(f.kind)}
         ${f.kind === 'push' ? 'AND branch = @ref' : ''}
       ORDER BY created_at, id`
    )
    .all({
      owner: repo.owner,
      name: repo.name,
      // Prefix match that can use the index: every hex sha starting with
      // `sha` sorts between `sha` and `sha` + 'g'.
      sha: f.sha,
      shaEnd: f.sha + 'g',
      workflow: f.workflow,
      ref: f.ref,
    });
  if (rows.length === 0) return null;

  const exact = rows.filter(
    r => r.status === 'completed' && FAILURE_CONCLUSIONS.includes(r.conclusion) && r.run_attempt === f.attempt
  );
  if (exact.length) return exact[exact.length - 1];
  const rerun = rows.filter(r => r.run_attempt > f.attempt);
  if (rerun.length) return rerun[rerun.length - 1];
  return rows[rows.length - 1];
}

/**
 * Rule 3: the most recent completed, non-skipped run of the same workflow on
 * `branch`, in the same event family, created after the failed run.
 */
function latestLaterRun(db, failed, branch, kind) {
  return db
    .prepare(
      `SELECT * FROM workflow_runs
       WHERE owner_name = @owner AND repo_name = @name
         AND workflow_id = @workflowId
         AND branch = @branch
         AND ${eventFamilySql(kind)}
         AND id != @id
         AND (created_at > @createdAt OR (created_at = @createdAt AND id > @id))
         AND status = 'completed'
         AND conclusion IS NOT NULL
         AND conclusion NOT IN (${SKIPPED_CONCLUSIONS.map(c => `'${c}'`).join(', ')})
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get({
      owner: failed.owner_name,
      name: failed.repo_name,
      workflowId: failed.workflow_id,
      branch,
      id: failed.id,
      createdAt: failed.created_at,
    });
}

/**
 * Cached GitHub lookups. Every value passed in comes from a GAV run row, never
 * from the request body, and the server's own token is used. A lookup that is
 * skipped or fails resolves to null, which callers treat as "no evidence".
 */
function createLookups(db) {
  const inFlight = new Map();

  function once(key, fn) {
    if (!inFlight.has(key)) {
      inFlight.set(key, fn().catch(err => {
        console.warn(`[resolve] GitHub lookup failed (${key}): ${err.message}`);
        return null;
      }));
    }
    return inFlight.get(key);
  }

  async function isTag(owner, name, ref) {
    const cached = db
      .prepare('SELECT is_tag, checked_at FROM ref_kinds WHERE owner_name = ? AND repo_name = ? AND ref = ?')
      .get(owner, name, ref);
    if (cached?.is_tag) return true;
    if (cached && Date.now() - Date.parse(cached.checked_at) < NOT_A_TAG_TTL_MS) return false;
    if (rateLimitTracker.shouldPause()) return null;
    return once(`tag:${owner}/${name}:${ref}`, async () => {
      const tag = await githubApi.isTag(owner, name, ref, { timeout: GITHUB_TIMEOUT_MS });
      db.prepare(
        `INSERT INTO ref_kinds (owner_name, repo_name, ref, is_tag, checked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_name, repo_name, ref) DO UPDATE SET is_tag = excluded.is_tag, checked_at = excluded.checked_at`
      ).run(owner, name, ref, tag ? 1 : 0, new Date().toISOString());
      return tag;
    });
  }

  /** Resolves 'open', 'closed' or null (unknown). */
  async function prState(owner, name, number) {
    const cached = db
      .prepare('SELECT state, checked_at FROM pr_states WHERE owner_name = ? AND repo_name = ? AND number = ?')
      .get(owner, name, number);
    if (cached) {
      const ttl = cached.state === 'closed' ? PR_CLOSED_TTL_MS : PR_OPEN_TTL_MS;
      if (Date.now() - Date.parse(cached.checked_at) < ttl) return cached.state;
    }
    if (rateLimitTracker.shouldPause()) return null;
    return once(`pr:${owner}/${name}#${number}`, async () => {
      const pr = await githubApi.getPullRequest(owner, name, number, { timeout: GITHUB_TIMEOUT_MS });
      if (pr?.state !== 'open' && pr?.state !== 'closed') return null;
      db.prepare(
        `INSERT INTO pr_states (owner_name, repo_name, number, state, merged, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_name, repo_name, number) DO UPDATE SET
           state = excluded.state, merged = excluded.merged, checked_at = excluded.checked_at`
      ).run(owner, name, number, pr.state, pr.merged ? 1 : 0, new Date().toISOString());
      return pr.state;
    });
  }

  return { isTag, prState };
}

/** Rule 4: a later success of the same workflow on another tag. */
async function supersedingTagRun(db, lookups, failed) {
  const candidates = db
    .prepare(
      `SELECT * FROM workflow_runs
       WHERE owner_name = @owner AND repo_name = @name
         AND workflow_id = @workflowId
         AND branch IS NOT NULL AND branch != @branch
         AND ${eventFamilySql('push')}
         AND (created_at > @createdAt OR (created_at = @createdAt AND id > @id))
         AND status = 'completed' AND conclusion = 'success'
       ORDER BY created_at DESC, id DESC
       LIMIT 50`
    )
    .all({
      owner: failed.owner_name,
      name: failed.repo_name,
      workflowId: failed.workflow_id,
      branch: failed.branch,
      createdAt: failed.created_at,
      id: failed.id,
    });

  const byRef = new Map();
  for (const run of candidates) {
    if (!byRef.has(run.branch)) byRef.set(run.branch, run);
    if (byRef.size >= MAX_TAG_CANDIDATES) break;
  }
  const refs = [...byRef.keys()];
  const tags = await Promise.all(refs.map(ref => lookups.isTag(failed.owner_name, failed.repo_name, ref)));
  const index = tags.findIndex(t => t === true);
  return index === -1 ? null : byRef.get(refs[index]);
}

async function resolveOne(db, lookups, input) {
  const f = normalise(input);
  if (!f) return result('unknown');
  const repo = findRepo(db, f.owner, f.name);
  if (!repo) return result('unknown');
  const failed = findFailedRun(db, repo, f);
  if (!failed) return result('unknown');

  // Rule 2. GAV keeps one row per run id and overwrites it on a re-run, so a
  // higher stored attempt means a re-run happened after the emailed failure.
  if (failed.run_attempt > f.attempt && failed.status === 'completed' && failed.conclusion === 'success') {
    return result('retried_ok', failed);
  }

  // Rule 5: the PR is identified from the run, never from the emailed title.
  if (f.kind === 'pr') {
    const prNumber = /\/pull\/(\d+)$/.exec(failed.pull_request_url || '')?.[1];
    if (prNumber) {
      const state = await lookups.prState(failed.owner_name, failed.repo_name, Number(prNumber));
      if (state === 'closed') return result('pr_closed', failed);
    }
  }

  // Rules 3 and 5 (head branch of the PR).
  const later = failed.branch ? latestLaterRun(db, failed, failed.branch, f.kind) : null;
  if (later?.conclusion === 'success') return result('superseded', later);

  // Rule 4: only refs GitHub confirms as tags.
  if (f.kind === 'push' && (await lookups.isTag(failed.owner_name, failed.repo_name, failed.branch)) === true) {
    const newer = await supersedingTagRun(db, lookups, failed);
    if (newer) return result('superseded', newer);
  }

  return result('still_failing', later || failed);
}

/**
 * Resolve a batch. Always returns exactly one result per input, in order; an
 * entry that cannot be resolved for any reason answers `unknown`.
 */
async function resolveFailures(failures) {
  const db = getDb();
  const lookups = createLookups(db);
  return Promise.all(
    failures.map(input =>
      resolveOne(db, lookups, input).catch(err => {
        console.error(`[resolve] failed to resolve an entry: ${err.message}`);
        return result('unknown');
      })
    )
  );
}

module.exports = { resolveFailures, MAX_BATCH: 50 };
