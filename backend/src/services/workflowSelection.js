const { getDb } = require('../db/database');
const githubApi = require('./githubApi');
const rateLimitTracker = require('./rateLimitTracker');
const { upsertRun } = require('./syncService');
const { effectiveDefaultBranch } = require('./reposService');

// Which workflows determine a repository's status (#6).
//
// Default rule (owner decision, 2026-10-05): a workflow counts when it is
// active, is not GitHub-managed (`dynamic/...`), and has run on push to the
// repo's effective default branch. Manual, scheduled and managed workflows are
// opt-in through `status_mode = 'include'`. Disabled workflows never count.

const MANAGED_PREFIX = 'dynamic/';
const STATUS_MODES = ['include', 'exclude'];

const REASONS = {
  push: 'default:push',
  manual: 'default:excluded-manual',
  managed: 'default:excluded-managed',
  unknownBranch: 'default:unknown-branch',
  disabled: 'disabled',
  include: 'explicit:include',
  exclude: 'explicit:exclude',
};

/**
 * Classify one workflow. `state` null (rows synced before GitHub reported a
 * state) is treated as active.
 */
function classify(workflow, branch, hasPushRun) {
  if (workflow.state && workflow.state !== 'active') {
    return { countsTowardStatus: false, reason: REASONS.disabled };
  }
  if (workflow.status_mode === 'include') return { countsTowardStatus: true, reason: REASONS.include };
  if (workflow.status_mode === 'exclude') return { countsTowardStatus: false, reason: REASONS.exclude };
  if ((workflow.path || '').startsWith(MANAGED_PREFIX)) {
    return { countsTowardStatus: false, reason: REASONS.managed };
  }
  if (!branch) return { countsTowardStatus: false, reason: REASONS.unknownBranch };
  if (hasPushRun) return { countsTowardStatus: true, reason: REASONS.push };
  return { countsTowardStatus: false, reason: REASONS.manual };
}

/**
 * Every workflow of a repo (a `repos` row), with whether it counts and why.
 */
function listRepoWorkflows(repo) {
  const db = getDb();
  const branch = effectiveDefaultBranch(repo);
  const rows = db
    .prepare(
      `SELECT w.*,
         EXISTS (
           SELECT 1 FROM workflow_runs r
           WHERE r.workflow_id = w.id AND r.event = 'push' AND r.branch = @branch
         ) AS has_push_run
       FROM workflows w
       WHERE w.owner_name = @owner AND w.repo_name = @name
       ORDER BY w.name COLLATE NOCASE, w.id`
    )
    .all({ owner: repo.owner, name: repo.name, branch });
  return rows.map(w => ({
    id: w.id,
    name: w.name,
    path: w.path || null,
    state: w.state || null,
    statusMode: w.status_mode || null,
    ...classify(w, branch, !!w.has_push_run),
  }));
}

/** The workflows that count toward a repo's status. Used by #7. */
function countedWorkflows(repo) {
  return listRepoWorkflows(repo).filter(w => w.countsTowardStatus);
}

/**
 * Set or reset a workflow's explicit mode. Returns the updated listing entry,
 * or null when the workflow does not belong to the repo.
 */
function setStatusMode(repo, workflowId, mode) {
  const db = getDb();
  const result = db
    .prepare('UPDATE workflows SET status_mode = @mode WHERE id = @id AND owner_name = @owner AND repo_name = @name')
    .run({ mode, id: workflowId, owner: repo.owner, name: repo.name });
  if (result.changes === 0) return null;
  return listRepoWorkflows(repo).find(w => w.id === workflowId) || null;
}

/**
 * Backfill push evidence (#6 refinement): GAV only reads the 30 newest runs per
 * repo, so a real push workflow on a busy repo can look manual. For each
 * candidate not yet checked against the current effective branch, ask GitHub
 * for its latest push run on that branch and store it if found.
 *
 * `budget` is shared across repos in a discovery cycle: { remaining: n }.
 * Returns the number of GitHub calls made.
 */
async function backfillPushEvidence(repo, accessToken, budget = { remaining: 10 }) {
  const branch = effectiveDefaultBranch(repo);
  if (!branch) return 0;
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT w.* FROM workflows w
       WHERE w.owner_name = @owner AND w.repo_name = @name
         AND (w.state IS NULL OR w.state = 'active')
         AND (w.path IS NULL OR w.path NOT LIKE 'dynamic/%')
         AND w.status_mode IS NULL
         AND (w.push_checked_branch IS NULL OR w.push_checked_branch != @branch)
         AND NOT EXISTS (
           SELECT 1 FROM workflow_runs r
           WHERE r.workflow_id = w.id AND r.event = 'push' AND r.branch = @branch
         )
       ORDER BY w.id`
    )
    .all({ owner: repo.owner, name: repo.name, branch });

  let calls = 0;
  const markChecked = db.prepare('UPDATE workflows SET push_checked_branch = ? WHERE id = ?');
  for (const wf of candidates) {
    if (budget.remaining <= 0 || rateLimitTracker.shouldPause()) break;
    budget.remaining--;
    calls++;
    try {
      const data = await githubApi.listRunsForWorkflow(
        repo.owner, repo.name, wf.id, { branch, event: 'push', per_page: 1 }, accessToken
      );
      const run = (data?.workflow_runs || [])[0];
      if (run) upsertRun(run, repo.owner, repo.name, wf.name);
      markChecked.run(branch, wf.id);
    } catch (err) {
      // Not marked: retried on a later cycle.
      console.warn(`[workflows] ${repo.owner}/${repo.name} "${wf.name}": push evidence check failed: ${err.message}`);
    }
  }
  return calls;
}

module.exports = {
  REASONS,
  STATUS_MODES,
  classify,
  listRepoWorkflows,
  countedWorkflows,
  setStatusMode,
  backfillPushEvidence,
};
