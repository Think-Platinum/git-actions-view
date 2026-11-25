const request = require('supertest');
const fs = require('fs');
const path = require('path');

// POST /api/v1/state/resolve (#11). Route tests on fixtures; GitHub is mocked.

const testDbPath = path.join(__dirname, 'test-state-resolve.sqlite');
const docPath = path.join(__dirname, '..', '..', 'docs', 'state-resolve-api.md');

const OWNER = 'Think-Platinum';
const REPO = 'app';

// 40-character shas whose 7-character prefixes are distinct.
const sha = prefix => (prefix + '0'.repeat(40)).slice(0, 40);

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const githubApi = require('../src/services/githubApi');
    const rateLimitTracker = require('../src/services/rateLimitTracker');
    const apiTokens = require('../src/services/apiTokens');
    const { getDb } = require('../src/db/database');

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.isAuthenticated = () => false;
      next();
    });
    app.use(require('../src/routes/state'));

    const github = {
      isTag: jest.spyOn(githubApi, 'isTag').mockResolvedValue(false),
      getPullRequest: jest.spyOn(githubApi, 'getPullRequest').mockRejectedValue(new Error('not mocked')),
    };
    const pause = jest.spyOn(rateLimitTracker, 'shouldPause').mockReturnValue(false);

    mods = { app, db: getDb(), github, pause, apiTokens };
  });
  return mods;
}

let nextId = 1000;

function seed(db) {
  db.prepare('INSERT INTO repos (owner, name) VALUES (?, ?)').run(OWNER, REPO);
  db.prepare('INSERT INTO repos (owner, name, hidden) VALUES (?, ?, 1)').run(OWNER, 'secret');
  const wf = db.prepare('INSERT INTO workflows (id, name, owner_name, repo_name) VALUES (?, ?, ?, ?)');
  wf.run(1, 'Deploy Dev', OWNER, REPO);
  wf.run(2, 'CI', OWNER, REPO);
  wf.run(3, 'Release', OWNER, REPO);
  wf.run(4, 'CI: Weekly', OWNER, REPO);
  wf.run(5, 'Deploy Dev', OWNER, 'secret');
}

const WORKFLOW_NAMES = { 1: 'Deploy Dev', 2: 'CI', 3: 'Release', 4: 'CI: Weekly', 5: 'Deploy Dev' };

function addRun(db, overrides = {}) {
  const run = {
    id: nextId++,
    workflow_id: 1,
    owner_name: OWNER,
    repo_name: REPO,
    run_number: 1,
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    branch: 'main',
    created_at: '2026-11-24T10:00:00Z',
    updated_at: '2026-11-24T10:05:00Z',
    run_attempt: 1,
    head_sha: sha('ef22f09'),
    pull_request_url: null,
    ...overrides,
  };
  run.workflow_name = overrides.workflow_name || WORKFLOW_NAMES[run.workflow_id];
  run.html_url = `https://github.com/${run.owner_name}/${run.repo_name}/actions/runs/${run.id}`;
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, owner_name, repo_name, workflow_name, run_number,
       status, conclusion, event, branch, html_url, created_at, updated_at, run_attempt, head_sha, pull_request_url)
     VALUES (@id, @workflow_id, @owner_name, @repo_name, @workflow_name, @run_number,
       @status, @conclusion, @event, @branch, @html_url, @created_at, @updated_at, @run_attempt, @head_sha, @pull_request_url)`
  ).run(run);
  return run;
}

const failure = (overrides = {}) => ({
  repo: `${OWNER}/${REPO}`,
  workflow: 'Deploy Dev',
  ref: 'main',
  sha: 'ef22f09',
  kind: 'push',
  attempt: 1,
  ...overrides,
});

async function resolve(app, failures) {
  const res = await request(app).post('/api/v1/state/resolve').send({ failures });
  expect(res.status).toBe(200);
  expect(res.body.results).toHaveLength(failures.length);
  return res.body.results;
}

describe('POST /api/v1/state/resolve (#11)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_OAUTH2_CLIENT_ID;
    delete process.env.GITHUB_OAUTH2_CLIENT_SECRET;
    delete process.env.BASIC_AUTH_USER_DETAILS_FILE_PATH;
    process.env.DB_PATH = testDbPath;
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      jest.isolateModules(() => {
        process.env.DB_PATH = testDbPath;
        require('../src/db/database').closeDb();
      });
    } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
    }
    process.env = { ...originalEnv };
  });

  describe('AC1: superseded by a newer run on the same branch', () => {
    test('a newer success of the same workflow on the same branch supersedes the failure', async () => {
      const { app, db, github } = load();
      seed(db);
      addRun(db, { id: 10 });
      addRun(db, { id: 11, conclusion: 'success', head_sha: sha('1234567'), created_at: '2026-11-24T11:00:00Z', updated_at: '2026-11-24T11:04:00Z' });

      const [r] = await resolve(app, [failure()]);
      expect(r).toEqual({
        outstanding: false,
        reason: 'superseded',
        latestRun: {
          id: 11,
          conclusion: 'success',
          headSha: sha('1234567'),
          completedAt: '2026-11-24T11:04:00Z',
          url: `https://github.com/${OWNER}/${REPO}/actions/runs/11`,
        },
      });
      // The common path answers from the database alone.
      expect(github.isTag).not.toHaveBeenCalled();
      expect(github.getPullRequest).not.toHaveBeenCalled();
    });

    test('a success on another branch, another workflow or a PR run does not supersede', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, {});
      const later = { conclusion: 'success', head_sha: sha('1234567'), created_at: '2026-11-24T11:00:00Z' };
      addRun(db, { ...later, branch: 'develop' });
      addRun(db, { ...later, workflow_id: 2 });
      addRun(db, { ...later, event: 'pull_request' });

      const [r] = await resolve(app, [failure()]);
      expect(r.reason).toBe('still_failing');
    });

    test('workflow names containing ": " are matched exactly', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 40, workflow_id: 4 });
      addRun(db, { id: 41, workflow_id: 4, conclusion: 'success', created_at: '2026-11-24T11:00:00Z' });

      const [weekly, ci] = await resolve(app, [failure({ workflow: 'CI: Weekly' }), failure({ workflow: 'CI' })]);
      expect(weekly.reason).toBe('superseded');
      expect(weekly.latestRun.id).toBe(41);
      expect(ci.reason).toBe('unknown');
    });

    test('schedule and manual runs count as push failures', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { event: 'schedule' });
      addRun(db, { event: 'workflow_dispatch', conclusion: 'success', created_at: '2026-11-24T11:00:00Z' });

      const [r] = await resolve(app, [failure()]);
      expect(r.reason).toBe('superseded');
    });
  });

  describe('AC2: retried_ok', () => {
    test('a failed run whose later attempt succeeded is retried_ok', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 20, conclusion: 'success', run_attempt: 2, updated_at: '2026-11-24T10:30:00Z' });

      const [r] = await resolve(app, [failure({ attempt: 1 })]);
      expect(r.outstanding).toBe(false);
      expect(r.reason).toBe('retried_ok');
      expect(r.latestRun.id).toBe(20);
      expect(r.latestRun.completedAt).toBe('2026-11-24T10:30:00Z');
    });

    test('a success at the same attempt contradicts the email and is not evidence', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { conclusion: 'success', run_attempt: 2 });

      const [r] = await resolve(app, [failure({ attempt: 2 })]);
      expect(r.reason).toBe('still_failing');
      expect(r.outstanding).toBe(true);
    });

    test('a re-run still in progress is not resolved', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { status: 'in_progress', conclusion: null, run_attempt: 3 });

      const [r] = await resolve(app, [failure({ attempt: 2 })]);
      expect(r.reason).toBe('still_failing');
      expect(r.latestRun.completedAt).toBeNull();
    });
  });

  describe('AC3: still_failing', () => {
    test('no later completed run: still failing, despite an older success', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 30, conclusion: 'success', head_sha: sha('aaaaaaa'), created_at: '2026-11-24T09:00:00Z' });
      addRun(db, { id: 31 });

      const [r] = await resolve(app, [failure()]);
      expect(r).toMatchObject({ outstanding: true, reason: 'still_failing', latestRun: { id: 31, conclusion: 'failure' } });
    });

    test('a later cancelled, skipped or in-progress run does not clear it', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 30, conclusion: 'success', head_sha: sha('aaaaaaa'), created_at: '2026-11-24T09:00:00Z' });
      addRun(db, { id: 31 });
      addRun(db, { id: 32, conclusion: 'cancelled', created_at: '2026-11-24T11:00:00Z' });
      addRun(db, { id: 33, conclusion: 'skipped', created_at: '2026-11-24T12:00:00Z' });
      addRun(db, { id: 34, status: 'in_progress', conclusion: null, created_at: '2026-11-24T13:00:00Z' });

      const [r] = await resolve(app, [failure()]);
      expect(r).toMatchObject({ outstanding: true, reason: 'still_failing', latestRun: { id: 31 } });
    });

    test('a later failure keeps it failing and is reported as the latest run', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 31 });
      addRun(db, { id: 35, conclusion: 'timed_out', created_at: '2026-11-24T11:00:00Z' });

      const [r] = await resolve(app, [failure()]);
      expect(r).toMatchObject({ reason: 'still_failing', latestRun: { id: 35, conclusion: 'timed_out' } });
    });

    test('only the most recent later run counts: success then failure is still failing', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 31 });
      addRun(db, { id: 36, conclusion: 'success', created_at: '2026-11-24T11:00:00Z' });
      addRun(db, { id: 37, conclusion: 'failure', created_at: '2026-11-24T12:00:00Z' });

      const [r] = await resolve(app, [failure()]);
      expect(r).toMatchObject({ reason: 'still_failing', latestRun: { id: 37 } });
    });
  });

  describe('AC4: newer tag', () => {
    function tagFixture(db) {
      seed(db);
      addRun(db, { id: 50, workflow_id: 3, branch: 'v1.12.1', conclusion: 'success', head_sha: sha('1111111'), created_at: '2026-11-23T10:00:00Z' });
      addRun(db, { id: 51, workflow_id: 3, branch: 'v1.12.2', head_sha: sha('2222222'), created_at: '2026-11-24T10:00:00Z' });
    }
    const tagFailure = failure({ workflow: 'Release', ref: 'v1.12.2', sha: '2222222' });

    test('a success on v1.12.3 supersedes a failure on v1.12.2', async () => {
      const { app, db, github } = load();
      tagFixture(db);
      addRun(db, { id: 52, workflow_id: 3, branch: 'v1.12.3', conclusion: 'success', head_sha: sha('3333333'), created_at: '2026-11-24T12:00:00Z' });
      github.isTag.mockResolvedValue(true);

      const [r] = await resolve(app, [tagFailure]);
      expect(r).toMatchObject({ outstanding: false, reason: 'superseded', latestRun: { id: 52, headSha: sha('3333333') } });
      expect(github.isTag).toHaveBeenCalledWith(OWNER, REPO, 'v1.12.2', expect.any(Object));
      expect(github.isTag).toHaveBeenCalledWith(OWNER, REPO, 'v1.12.3', expect.any(Object));
    });

    test('an older tag success, or a later success on a ref GitHub says is not a tag, does not supersede', async () => {
      const { app, db, github } = load();
      tagFixture(db);
      addRun(db, { id: 53, workflow_id: 3, branch: 'release-branch', conclusion: 'success', created_at: '2026-11-24T12:00:00Z' });
      github.isTag.mockImplementation(async (owner, repo, ref) => ref !== 'release-branch');

      const [r] = await resolve(app, [tagFailure]);
      expect(r).toMatchObject({ outstanding: true, reason: 'still_failing', latestRun: { id: 51 } });
    });

    test('a branch is never superseded by another ref', async () => {
      const { app, db, github } = load();
      seed(db);
      addRun(db, { branch: 'feature-x' });
      addRun(db, { branch: 'v9.9.9', conclusion: 'success', created_at: '2026-11-24T12:00:00Z' });
      github.isTag.mockImplementation(async (owner, repo, ref) => ref === 'v9.9.9');

      const [r] = await resolve(app, [failure({ ref: 'feature-x' })]);
      expect(r.reason).toBe('still_failing');
    });

    test('tag answers are cached, and a failed lookup is not evidence', async () => {
      const { app, db, github } = load();
      tagFixture(db);
      addRun(db, { id: 52, workflow_id: 3, branch: 'v1.12.3', conclusion: 'success', created_at: '2026-11-24T12:00:00Z' });

      github.isTag.mockRejectedValue(new Error('network down'));
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await resolve(app, [tagFailure]))[0].reason).toBe('still_failing');

      github.isTag.mockResolvedValue(true);
      expect((await resolve(app, [tagFailure]))[0].reason).toBe('superseded');
      const calls = github.isTag.mock.calls.length;
      expect((await resolve(app, [tagFailure]))[0].reason).toBe('superseded');
      expect(github.isTag.mock.calls.length).toBe(calls);
    });
  });

  describe('AC5: pr_closed', () => {
    function prFixture(db) {
      seed(db);
      addRun(db, {
        id: 60,
        workflow_id: 2,
        event: 'pull_request',
        branch: 'fix-expiry',
        head_sha: sha('0a1e314'),
        pull_request_url: `https://github.com/${OWNER}/${REPO}/pull/42`,
      });
    }
    const prFailure = failure({ workflow: 'CI', kind: 'pr', sha: '0a1e314', ref: 'fix: declare the 13 Firestore expiry policies (#1559)' });

    test('a PR run whose PR is merged returns pr_closed', async () => {
      const { app, db, github } = load();
      prFixture(db);
      github.getPullRequest.mockResolvedValue({ state: 'closed', merged: true });

      const [r] = await resolve(app, [prFailure]);
      expect(r).toMatchObject({ outstanding: false, reason: 'pr_closed', latestRun: { id: 60 } });
      expect(github.getPullRequest).toHaveBeenCalledWith(OWNER, REPO, 42, expect.any(Object));
    });

    test('if the PR lookup fails, the failure is not reported resolved', async () => {
      const { app, db, github } = load();
      prFixture(db);
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      github.getPullRequest.mockRejectedValue(new Error('502 Bad Gateway'));

      const [r] = await resolve(app, [prFailure]);
      expect(r).toMatchObject({ outstanding: true, reason: 'still_failing' });
    });

    test('while the rate limit pause is active, no call is made and nothing is resolved', async () => {
      const { app, db, github, pause } = load();
      prFixture(db);
      pause.mockReturnValue(true);
      github.getPullRequest.mockResolvedValue({ state: 'closed', merged: true });

      const [r] = await resolve(app, [prFailure]);
      expect(r.reason).toBe('still_failing');
      expect(github.getPullRequest).not.toHaveBeenCalled();
    });

    test('an open PR with a later successful PR run on its head branch is superseded', async () => {
      const { app, db, github } = load();
      prFixture(db);
      addRun(db, { id: 61, workflow_id: 2, event: 'pull_request', branch: 'fix-expiry', conclusion: 'success', created_at: '2026-11-24T11:00:00Z' });
      github.getPullRequest.mockResolvedValue({ state: 'open', merged: false });

      const [r] = await resolve(app, [prFailure]);
      expect(r).toMatchObject({ reason: 'superseded', latestRun: { id: 61 } });
    });

    test('the PR title is ignored, and a closed PR answer is cached', async () => {
      const { app, db, github } = load();
      prFixture(db);
      github.getPullRequest.mockResolvedValue({ state: 'closed', merged: false });

      await resolve(app, [prFailure]);
      const [r] = await resolve(app, [{ ...prFailure, ref: 'a completely different title' }]);
      expect(r.reason).toBe('pr_closed');
      expect(github.getPullRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC6: unknown', () => {
    test('unknown repo, unknown sha, hidden repo and malformed entries answer unknown', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, {});
      addRun(db, { repo_name: 'secret', workflow_id: 5 });

      const results = await resolve(app, [
        failure({ repo: 'Think-Platinum/not-watched' }),
        failure({ sha: 'deadbee' }),
        failure({ repo: `${OWNER}/secret` }),
        failure({ sha: 'xyz' }),
        failure({ kind: 'tag' }),
        failure({ repo: 'no-slash' }),
        failure({ attempt: 0 }),
        null,
        'not an object',
      ]);
      for (const r of results) {
        expect(r).toEqual({ outstanding: true, reason: 'unknown' });
      }
    });

    test('a run synced before head_sha was stored answers unknown', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { head_sha: null });
      const [r] = await resolve(app, [failure()]);
      expect(r).toEqual({ outstanding: true, reason: 'unknown' });
    });

    test('repo names are matched case-insensitively and shas in any case', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, {});
      const [r] = await resolve(app, [failure({ repo: 'think-platinum/APP', sha: 'EF22F09' })]);
      expect(r.reason).toBe('still_failing');
    });
  });

  describe('AC7: order and count', () => {
    test('results preserve input order and count for a mixed batch', async () => {
      const { app, db, github } = load();
      seed(db);
      // superseded
      addRun(db, { id: 70, head_sha: sha('aaaaaaa') });
      addRun(db, { id: 71, conclusion: 'success', head_sha: sha('aaaaaab'), created_at: '2026-11-24T11:00:00Z' });
      // retried_ok
      addRun(db, { id: 72, branch: 'other', head_sha: sha('bbbbbbb'), conclusion: 'success', run_attempt: 2 });
      // still failing
      addRun(db, { id: 73, branch: 'third', head_sha: sha('ccccccc') });
      // pr_closed
      addRun(db, { id: 74, workflow_id: 2, event: 'pull_request', branch: 'pr-branch', head_sha: sha('ddddddd'),
        pull_request_url: `https://github.com/${OWNER}/${REPO}/pull/7` });
      github.getPullRequest.mockResolvedValue({ state: 'closed', merged: true });

      const input = [
        failure({ sha: 'ccccccc', ref: 'third' }),
        failure({ sha: 'deadbee' }),
        failure({ sha: 'aaaaaaa' }),
        failure({ workflow: 'CI', kind: 'pr', sha: 'ddddddd', ref: 'Some title' }),
        failure({ sha: 'bbbbbbb', ref: 'other', attempt: 1 }),
        failure({ sha: 'ccccccc', ref: 'third' }),
      ];
      const results = await resolve(app, input);
      expect(results.map(r => r.reason)).toEqual([
        'still_failing', 'unknown', 'superseded', 'pr_closed', 'retried_ok', 'still_failing',
      ]);
      expect(results.map(r => r.outstanding)).toEqual([true, true, false, false, false, true]);
    });

    test('an empty batch returns an empty result list', async () => {
      const { app } = load();
      expect(await resolve(app, [])).toEqual([]);
    });
  });

  describe('request validation', () => {
    test('rejects a body without a failures array, or more than 50 entries', async () => {
      const { app } = load();
      expect((await request(app).post('/api/v1/state/resolve').send({})).status).toBe(400);
      expect((await request(app).post('/api/v1/state/resolve').send({ failures: 'x' })).status).toBe(400);
      const tooMany = Array.from({ length: 51 }, () => failure());
      expect((await request(app).post('/api/v1/state/resolve').send({ failures: tooMany })).status).toBe(400);
    });

    test('responses are not cacheable', async () => {
      const { app } = load();
      const res = await request(app).post('/api/v1/state/resolve').send({ failures: [] });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('AC8: auth', () => {
    beforeEach(() => {
      process.env.GITHUB_OAUTH2_CLIENT_ID = 'id';
      process.env.GITHUB_OAUTH2_CLIENT_SECRET = 'secret';
    });

    test('no session or token: 401', async () => {
      const { app } = load();
      const res = await request(app).post('/api/v1/state/resolve').send({ failures: [] });
      expect(res.status).toBe(401);
    });

    test('a valid read-only token: 200; a revoked token: 401', async () => {
      const { app, db, apiTokens } = load();
      seed(db);
      addRun(db, {});
      const { token, id } = apiTokens.createToken('auden');

      const ok = await request(app)
        .post('/api/v1/state/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({ failures: [failure()] });
      expect(ok.status).toBe(200);
      expect(ok.body.results[0].reason).toBe('still_failing');

      apiTokens.revokeToken(id);
      const revoked = await request(app)
        .post('/api/v1/state/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({ failures: [failure()] });
      expect(revoked.status).toBe(401);
    });
  });

  describe('AC9: contract doc', () => {
    function docExample() {
      const doc = fs.readFileSync(docPath, 'utf8');
      const match = /<!-- response-example -->\s*```json\n([\s\S]*?)```/.exec(doc);
      expect(match).not.toBeNull();
      return JSON.parse(match[1]);
    }

    const keys = objects => [...new Set(objects.flatMap(o => Object.keys(o)))].sort();

    test('docs/state-resolve-api.md matches the response shape in both directions', async () => {
      const { app, db } = load();
      seed(db);
      addRun(db, { id: 80 });
      addRun(db, { id: 81, conclusion: 'success', created_at: '2026-11-24T11:00:00Z' });
      const real = { results: await resolve(app, [failure(), failure({ sha: 'deadbee' })]) };
      const example = docExample();

      expect(keys([real])).toEqual(keys([example]));
      expect(keys(real.results)).toEqual(keys(example.results));
      const runs = r => r.results.filter(x => x.latestRun).map(x => x.latestRun);
      expect(keys(runs(real))).toEqual(keys(runs(example)));

      // The documented reason vocabulary is the one the code uses.
      const doc = fs.readFileSync(docPath, 'utf8');
      for (const reason of ['still_failing', 'superseded', 'retried_ok', 'pr_closed', 'unknown']) {
        expect(doc).toContain(`\`${reason}\``);
      }
    });
  });
});
