const request = require('supertest');
const fs = require('fs');
const path = require('path');

// GET /api/v1/status (#7). Route tests on fixtures with a fixed clock.

const testDbPath = path.join(__dirname, 'test-status.sqlite');
const docPath = path.join(__dirname, '..', '..', 'docs', 'status-api.md');
const NOW = Date.parse('2026-11-27T09:00:00Z');

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const apiTokens = require('../src/services/apiTokens');
    const { getDb } = require('../src/db/database');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.isAuthenticated = () => false;
      next();
    });
    app.use(require('../src/routes/status'));
    app.use(require('../src/routes/runs'));
    mods = { app, db: getDb(), apiTokens };
  });
  return mods;
}

let nextId = 1;
const iso = ms => new Date(ms).toISOString();
const minutesAgo = m => iso(NOW - m * 60 * 1000);

function addRepo(db, name, { branch = 'main', hidden = 0, override = null } = {}) {
  db.prepare('INSERT INTO repos (owner, name, hidden, default_branch, default_branch_override) VALUES (?, ?, ?, ?, ?)')
    .run('org', name, hidden, branch, override);
}

function addWorkflow(db, repo, id, name, { path: wfPath = `.github/workflows/${id}.yml`, state = 'active', mode = null } = {}) {
  db.prepare('INSERT INTO workflows (id, name, owner_name, repo_name, path, state, status_mode) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, 'org', repo, wfPath, state, mode);
}

/** Insert a run. `ageMin` sets created_at; `durationS` sets updated_at for completed runs. */
function addRun(db, repo, workflowId, over = {}) {
  const ageMin = over.ageMin ?? 60;
  const created = NOW - ageMin * 60 * 1000;
  const durationS = over.durationS ?? 60;
  const status = over.status ?? 'completed';
  const run = {
    id: over.id ?? nextId++,
    workflow_id: workflowId,
    owner_name: 'org',
    repo_name: repo,
    workflow_name: 'wf',
    run_number: over.runNumber ?? 1,
    status,
    conclusion: status === 'completed' ? (over.conclusion ?? 'success') : null,
    event: over.event ?? 'push',
    branch: over.branch ?? 'main',
    html_url: `https://github.com/org/${repo}/actions/runs/x`,
    created_at: iso(created),
    updated_at: over.updatedAt ?? iso(created + durationS * 1000),
    run_started_at: over.startedAt ?? iso(created),
  };
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, owner_name, repo_name, workflow_name, run_number, status, conclusion,
       event, branch, html_url, created_at, updated_at, run_started_at)
     VALUES (@id, @workflow_id, @owner_name, @repo_name, @workflow_name, @run_number, @status, @conclusion,
       @event, @branch, @html_url, @created_at, @updated_at, @run_started_at)`
  ).run(run);
  return run;
}

async function getStatus(app) {
  const res = await request(app).get('/api/v1/status');
  expect(res.status).toBe(200);
  return res.body;
}
const repoOf = (body, name) => body.repos.find(r => r.name === name);

describe('GET /api/v1/status (#7)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_OAUTH2_CLIENT_ID;
    delete process.env.GITHUB_OAUTH2_CLIENT_SECRET;
    delete process.env.BASIC_AUTH_USER_DETAILS_FILE_PATH;
    process.env.DB_PATH = testDbPath;
    for (const s of ['', '-shm', '-wal']) if (fs.existsSync(testDbPath + s)) fs.unlinkSync(testDbPath + s);
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      jest.isolateModules(() => {
        process.env.DB_PATH = testDbPath;
        require('../src/db/database').closeDb();
      });
    } catch { /* ignore */ }
    for (const s of ['', '-shm', '-wal']) if (fs.existsSync(testDbPath + s)) fs.unlinkSync(testDbPath + s);
    process.env = { ...originalEnv };
  });

  test('AC1: a failure in a manual-only workflow does not make the repo fail', async () => {
    const { app, db } = load();
    addRepo(db, 'cohorta');
    addWorkflow(db, 'cohorta', 1, 'Launch Production');
    addWorkflow(db, 'cohorta', 2, 'CI');
    addRun(db, 'cohorta', 1, { event: 'workflow_dispatch', conclusion: 'failure', ageMin: 60 * 24 * 200 });
    addRun(db, 'cohorta', 2, { conclusion: 'success' });

    const repo = repoOf(await getStatus(app), 'cohorta');
    expect(repo.failing).toBe(false);
    expect(repo.workflows.map(w => w.name)).toEqual(['CI']);
  });

  test('AC2: only the latest run counts; a stuck queued run behind newer successes is ignored', async () => {
    const { app, db } = load();
    addRepo(db, 'cohorta');
    addWorkflow(db, 'cohorta', 3, 'Build Images');
    addRun(db, 'cohorta', 3, { status: 'queued', ageMin: 60 * 24 * 110 });
    for (const age of [400, 300, 200, 100]) addRun(db, 'cohorta', 3, { ageMin: age });

    const body = await getStatus(app);
    const repo = repoOf(body, 'cohorta');
    expect(repo).toMatchObject({ queued: false, building: false, failing: false });
    expect(body.overall).toMatchObject({ queued: false, building: false });
  });

  test('AC2: ties on created_at are broken by run id', async () => {
    const { app, db } = load();
    addRepo(db, 'r');
    addWorkflow(db, 'r', 4, 'CI');
    addRun(db, 'r', 4, { id: 900, ageMin: 10 });
    addRun(db, 'r', 4, { id: 901, ageMin: 10, status: 'in_progress' });
    const wf = repoOf(await getStatus(app), 'r').workflows[0];
    expect(wf).toMatchObject({ runId: 901, building: true });
  });

  test('AC3: building after a failure is building and failing, at repo and overall level', async () => {
    const { app, db } = load();
    addRepo(db, 'r');
    addWorkflow(db, 'r', 5, 'CI');
    addRun(db, 'r', 5, { conclusion: 'failure', ageMin: 30 });
    addRun(db, 'r', 5, { status: 'in_progress', ageMin: 1 });

    const body = await getStatus(app);
    expect(repoOf(body, 'r')).toMatchObject({ building: true, failing: true });
    expect(repoOf(body, 'r').workflows[0]).toMatchObject({ building: true, failing: true, status: 'in_progress', conclusion: null });
    expect(body.overall).toMatchObject({ building: true, failing: true });
  });

  test('AC4: a cancelled latest completed run is passed over; the failure before it counts', async () => {
    const { app, db } = load();
    addRepo(db, 'r');
    addWorkflow(db, 'r', 6, 'CI');
    addRun(db, 'r', 6, { conclusion: 'failure', ageMin: 30 });
    addRun(db, 'r', 6, { conclusion: 'cancelled', ageMin: 10 });
    const repo = repoOf(await getStatus(app), 'r');
    expect(repo.failing).toBe(true);
    expect(repo.workflows[0].conclusion).toBe('cancelled');
  });

  test('action_required is not failing; timed_out and startup_failure are', async () => {
    const { app, db } = load();
    addRepo(db, 'r');
    addWorkflow(db, 'r', 7, 'A');
    addWorkflow(db, 'r', 8, 'B');
    addWorkflow(db, 'r', 9, 'C');
    addRun(db, 'r', 7, { conclusion: 'action_required' });
    addRun(db, 'r', 8, { conclusion: 'timed_out' });
    addRun(db, 'r', 9, { conclusion: 'startup_failure' });
    const wfs = repoOf(await getStatus(app), 'r').workflows;
    expect(wfs.map(w => [w.name, w.failing])).toEqual([['A', false], ['B', true], ['C', true]]);
  });

  describe('AC5: progress', () => {
    function progressFixture(db, durations, elapsedS) {
      addRepo(db, 'r');
      addWorkflow(db, 'r', 10, 'CI');
      durations.forEach((d, i) => addRun(db, 'r', 10, { ageMin: 100 + i * 10, durationS: d }));
      addRun(db, 'r', 10, { status: 'in_progress', ageMin: 1, startedAt: iso(NOW - elapsedS * 1000) });
    }

    test('[60, 60, 60, 120] with 30 s elapsed: progress 0.5, ETA 30', async () => {
      const { app, db } = load();
      progressFixture(db, [60, 60, 60, 120], 30);
      expect(repoOf(await getStatus(app), 'r').workflows[0]).toMatchObject({ progress: 0.5, etaSeconds: 30, overrun: false });
    });

    test('with 2 samples progress is null', async () => {
      const { app, db } = load();
      progressFixture(db, [60, 60], 30);
      expect(repoOf(await getStatus(app), 'r').workflows[0]).toMatchObject({ progress: null, etaSeconds: null, overrun: false });
    });

    test('overrun past the nearest-rank p90 (120 s), not before; progress caps at 0.99', async () => {
      const { app, db } = load();
      progressFixture(db, [60, 60, 60, 120], 119);
      expect(repoOf(await getStatus(app), 'r').workflows[0].overrun).toBe(false);
      db.prepare("UPDATE workflow_runs SET run_started_at = ? WHERE status = 'in_progress'").run(iso(NOW - 121 * 1000));
      expect(repoOf(await getStatus(app), 'r').workflows[0]).toMatchObject({ overrun: true, progress: 0.99, etaSeconds: 0 });
    });

    test('a 400-day outlier duration is discarded', async () => {
      const { app, db } = load();
      progressFixture(db, [60, 60, 60, 400 * 24 * 3600], 30);
      // Without the outlier the samples are [60, 60, 60]: median 60, p90 60.
      expect(repoOf(await getStatus(app), 'r').workflows[0]).toMatchObject({ progress: 0.5, etaSeconds: 30, overrun: false });
    });

    test('job completion times are preferred over updated_at', async () => {
      const { app, db } = load();
      progressFixture(db, [60, 60, 60], 30);
      // Move updated_at months on for every success, as GitHub sometimes does; jobs still say 60 s.
      const runs = db.prepare("SELECT id, run_started_at FROM workflow_runs WHERE status = 'completed'").all();
      for (const r of runs) {
        db.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run('2027-03-01T00:00:00Z', r.id);
        db.prepare("INSERT INTO workflow_jobs (id, run_id, name, status, conclusion, started_at, completed_at) VALUES (?, ?, 'build', 'completed', 'success', ?, ?)")
          .run(r.id + 100000, r.id, r.run_started_at, iso(Date.parse(r.run_started_at) + 60 * 1000));
      }
      expect(repoOf(await getStatus(app), 'r').workflows[0]).toMatchObject({ progress: 0.5, etaSeconds: 30 });
    });
  });

  test('AC6: a repo with no effective default branch is unknown and counted', async () => {
    const { app, db } = load();
    addRepo(db, 'nobranch', { branch: null });
    addWorkflow(db, 'nobranch', 11, 'CI');
    addRun(db, 'nobranch', 11, { conclusion: 'failure' });
    addRepo(db, 'ok');
    addWorkflow(db, 'ok', 12, 'CI');
    addRun(db, 'ok', 12, {});

    const body = await getStatus(app);
    expect(repoOf(body, 'nobranch')).toMatchObject({
      unknown: true, failing: false, building: false, queued: false, defaultBranch: null, workflows: [],
    });
    expect(body.overall.unknown).toBe(1);
  });

  test('AC9: a repo where nothing counts has noCountedWorkflows and is not unknown', async () => {
    const { app, db } = load();
    addRepo(db, 'manual');
    addWorkflow(db, 'manual', 13, 'Deploy');
    addRun(db, 'manual', 13, { event: 'workflow_dispatch', conclusion: 'failure' });
    const body = await getStatus(app);
    expect(repoOf(body, 'manual')).toMatchObject({ noCountedWorkflows: true, unknown: false, failing: false, workflows: [] });
    expect(body.overall).toMatchObject({ unknown: 0, failing: false });
  });

  test('a branch override is used, and counted workflows with no run on the branch make the repo unknown', async () => {
    const { app, db } = load();
    addRepo(db, 'r', { override: 'release' });
    addWorkflow(db, 'r', 14, 'CI', { mode: 'include' });
    addRun(db, 'r', 14, { branch: 'main', conclusion: 'failure' });
    const repo = repoOf(await getStatus(app), 'r');
    expect(repo).toMatchObject({ defaultBranch: 'release', unknown: true, failing: false });
  });

  test('AC10: hidden repos are excluded, and repoCount counts visible repos', async () => {
    const { app, db } = load();
    addRepo(db, 'visible');
    addRepo(db, 'secret', { hidden: 1 });
    addWorkflow(db, 'secret', 15, 'CI');
    addRun(db, 'secret', 15, { conclusion: 'failure' });
    const body = await getStatus(app);
    expect(body.repos.map(r => r.name)).toEqual(['visible']);
    expect(body.overall).toMatchObject({ repoCount: 1, failing: false });
  });

  describe('AC7 and AC8: shape and contract', () => {
    const EXPECTED = {
      top: ['generatedAt', 'overall', 'repos', 'schemaVersion'],
      overall: ['building', 'failing', 'queued', 'repoCount', 'unknown'],
      repo: ['building', 'defaultBranch', 'failing', 'name', 'noCountedWorkflows', 'owner', 'queued', 'unknown', 'workflows'],
      workflow: ['building', 'conclusion', 'etaSeconds', 'failing', 'htmlUrl', 'id', 'name', 'overrun', 'progress',
        'queued', 'runId', 'runNumber', 'startedAt', 'status'],
    };
    const keys = o => Object.keys(o).sort();

    async function fullFixture() {
      const { app, db } = load();
      addRepo(db, 'r');
      addWorkflow(db, 'r', 16, 'CI');
      addRun(db, 'r', 16, { status: 'in_progress', ageMin: 1 });
      return getStatus(app);
    }

    test('AC7: exactly the documented fields at every level, and no presentation fields', async () => {
      const body = await fullFixture();
      expect(keys(body)).toEqual(EXPECTED.top);
      expect(keys(body.overall)).toEqual(EXPECTED.overall);
      expect(keys(body.repos[0])).toEqual(EXPECTED.repo);
      expect(keys(body.repos[0].workflows[0])).toEqual(EXPECTED.workflow);
      expect(JSON.stringify(body)).not.toMatch(/colou?r|led|rgb|effect|"hex"/i);
      expect(body.schemaVersion).toBe(1);
    });

    test('AC8: docs/status-api.md matches the response shape in both directions', async () => {
      const doc = fs.readFileSync(docPath, 'utf8');
      const match = /<!-- response-example -->\s*```json\n([\s\S]*?)```/.exec(doc);
      expect(match).not.toBeNull();
      const example = JSON.parse(match[1]);
      const body = await fullFixture();
      expect(keys(body)).toEqual(keys(example));
      expect(keys(body.overall)).toEqual(keys(example.overall));
      expect(keys(body.repos[0])).toEqual(keys(example.repos[0]));
      expect(keys(body.repos[0].workflows[0])).toEqual(keys(example.repos[0].workflows[0]));
      expect(example.schemaVersion).toBe(body.schemaVersion);
    });
  });

  describe('AC11: token access', () => {
    beforeEach(() => {
      process.env.GITHUB_OAUTH2_CLIENT_ID = 'id';
      process.env.GITHUB_OAUTH2_CLIENT_SECRET = 'secret';
    });

    test('valid token 200 with no-store; no credential 401; the token cannot read /api/v1/runs', async () => {
      const { app, apiTokens } = load();
      const { token } = apiTokens.createToken('wled');
      const ok = await request(app).get('/api/v1/status').set('Authorization', `Bearer ${token}`);
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect((await request(app).get('/api/v1/status')).status).toBe(401);
      expect((await request(app).get('/api/v1/runs').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    });
  });
});
