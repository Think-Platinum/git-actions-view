const request = require('supertest');
const fs = require('fs');
const path = require('path');

// #6: which workflows determine a repository's status.

jest.mock('../src/services/syncDispatcher', () => ({ syncSingleRepo: jest.fn() }));

const testDbPath = path.join(__dirname, 'test-workflow-selection.sqlite');

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const githubApi = require('../src/services/githubApi');
    const rateLimitTracker = require('../src/services/rateLimitTracker');
    const reposService = require('../src/services/reposService');
    const workflowSelection = require('../src/services/workflowSelection');
    const { getDb } = require('../src/db/database');
    const app = express();
    app.use(express.json());
    app.use(require('../src/routes/repos'));
    const listRuns = jest.spyOn(githubApi, 'listRunsForWorkflow');
    const pause = jest.spyOn(rateLimitTracker, 'shouldPause').mockReturnValue(false);
    mods = { app, db: getDb(), reposService, workflowSelection, listRuns, pause };
  });
  return mods;
}

let runId = 5000;

/**
 * Fixture modelled on the live findings (2026-10-05): a manual-only deploy, a
 * push CI on the default branch, and a GitHub-managed Copilot workflow.
 */
function seedCohorta(db, { branch = 'main' } = {}) {
  db.prepare('INSERT INTO repos (owner, name, default_branch) VALUES (?, ?, ?)').run('Think-Platinum', 'cohorta', branch);
  const wf = db.prepare('INSERT INTO workflows (id, name, owner_name, repo_name, path, state) VALUES (?, ?, ?, ?, ?, ?)');
  wf.run(1, 'Launch Production', 'Think-Platinum', 'cohorta', '.github/workflows/launch-production.yml', 'active');
  wf.run(2, 'CI - Validate and Test', 'Think-Platinum', 'cohorta', '.github/workflows/ci.yml', 'active');
  wf.run(3, 'Copilot', 'Think-Platinum', 'cohorta', 'dynamic/agents/copilot-swe-agent', 'active');
  wf.run(4, 'Old Deploy', 'Think-Platinum', 'cohorta', '.github/workflows/old.yml', 'disabled_manually');
  addRun(db, { workflow_id: 1, event: 'workflow_dispatch', branch });
  addRun(db, { workflow_id: 2, event: 'push', branch });
  addRun(db, { workflow_id: 2, event: 'pull_request', branch: 'feature' });
  addRun(db, { workflow_id: 3, event: 'dynamic', branch });
  addRun(db, { workflow_id: 4, event: 'push', branch });
  return db.prepare('SELECT * FROM repos WHERE name = ?').get('cohorta');
}

function addRun(db, over) {
  const run = {
    id: runId++, owner_name: 'Think-Platinum', repo_name: 'cohorta', workflow_name: 'x', run_number: 1,
    status: 'completed', conclusion: 'success', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:05:00Z',
    ...over,
  };
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, owner_name, repo_name, workflow_name, run_number, status, conclusion, event, branch, created_at, updated_at)
     VALUES (@id, @workflow_id, @owner_name, @repo_name, @workflow_name, @run_number, @status, @conclusion, @event, @branch, @created_at, @updated_at)`
  ).run(run);
}

const byName = (list, name) => list.find(w => w.name === name);

describe('workflow selection (#6)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_OAUTH2_CLIENT_ID;
    delete process.env.GITHUB_OAUTH2_CLIENT_SECRET;
    delete process.env.BASIC_AUTH_USER_DETAILS_FILE_PATH;
    process.env.DB_PATH = testDbPath;
    for (const s of ['', '-shm', '-wal']) if (fs.existsSync(testDbPath + s)) fs.unlinkSync(testDbPath + s);
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

  test('AC1: the default rule matches the live findings', () => {
    const { db, workflowSelection } = load();
    const repo = seedCohorta(db);
    const list = workflowSelection.listRepoWorkflows(repo);

    expect(byName(list, 'Launch Production')).toMatchObject({ countsTowardStatus: false, reason: 'default:excluded-manual' });
    expect(byName(list, 'CI - Validate and Test')).toMatchObject({ countsTowardStatus: true, reason: 'default:push' });
    expect(byName(list, 'Copilot')).toMatchObject({ countsTowardStatus: false, reason: 'default:excluded-managed' });
    expect(workflowSelection.countedWorkflows(repo).map(w => w.name)).toEqual(['CI - Validate and Test']);
  });

  test('AC2: disabled overrides include, and an excluded disabled workflow reports disabled', () => {
    const { db, workflowSelection } = load();
    const repo = seedCohorta(db);
    expect(byName(workflowSelection.listRepoWorkflows(repo), 'Old Deploy')).toMatchObject({ countsTowardStatus: false, reason: 'disabled' });
    expect(workflowSelection.setStatusMode(repo, 4, 'include')).toMatchObject({ countsTowardStatus: false, reason: 'disabled', statusMode: 'include' });
    expect(workflowSelection.setStatusMode(repo, 4, 'exclude')).toMatchObject({ reason: 'disabled' });
  });

  test('AC3: explicit include and exclude round-trip through the API, and reset returns to the default rule', async () => {
    const { app, db } = load();
    const repo = seedCohorta(db);

    const list = await request(app).get(`/api/v1/repos/${repo.id}/workflows`);
    expect(list.status).toBe(200);
    expect(list.body.effectiveDefaultBranch).toBe('main');
    expect(list.body.workflows).toHaveLength(4);

    const include = await request(app).put(`/api/v1/repos/${repo.id}/workflows/1`).send({ statusMode: 'include' });
    expect(include.body.workflow).toMatchObject({ name: 'Launch Production', countsTowardStatus: true, reason: 'explicit:include' });

    const managed = await request(app).put(`/api/v1/repos/${repo.id}/workflows/3`).send({ statusMode: 'include' });
    expect(managed.body.workflow).toMatchObject({ countsTowardStatus: true, reason: 'explicit:include' });

    const exclude = await request(app).put(`/api/v1/repos/${repo.id}/workflows/2`).send({ statusMode: 'exclude' });
    expect(exclude.body.workflow).toMatchObject({ countsTowardStatus: false, reason: 'explicit:exclude' });

    const reset = await request(app).put(`/api/v1/repos/${repo.id}/workflows/2`).send({ statusMode: null });
    expect(reset.body.workflow).toMatchObject({ countsTowardStatus: true, reason: 'default:push', statusMode: null });
  });

  test('API validation: bad mode 400, missing mode 400, foreign or unknown workflow 404', async () => {
    const { app, db } = load();
    const repo = seedCohorta(db);
    db.prepare('INSERT INTO repos (owner, name) VALUES (?, ?)').run('other', 'repo');
    const other = db.prepare('SELECT * FROM repos WHERE owner = ?').get('other');

    expect((await request(app).put(`/api/v1/repos/${repo.id}/workflows/1`).send({ statusMode: 'always' })).status).toBe(400);
    expect((await request(app).put(`/api/v1/repos/${repo.id}/workflows/1`).send({})).status).toBe(400);
    expect((await request(app).put(`/api/v1/repos/${repo.id}/workflows/abc`).send({ statusMode: null })).status).toBe(400);
    expect((await request(app).put(`/api/v1/repos/${other.id}/workflows/1`).send({ statusMode: 'include' })).status).toBe(404);
    expect((await request(app).put(`/api/v1/repos/${repo.id}/workflows/999`).send({ statusMode: 'include' })).status).toBe(404);
    expect((await request(app).get('/api/v1/repos/999/workflows')).status).toBe(404);
  });

  test('AC4: the rule uses the effective default branch, not main', () => {
    const { db, workflowSelection } = load();
    const repo = seedCohorta(db, { branch: 'develop' });
    // A push run on main alone must not count for a develop repo.
    addRun(db, { workflow_id: 1, event: 'push', branch: 'main' });
    const list = workflowSelection.listRepoWorkflows(repo);
    expect(byName(list, 'CI - Validate and Test')).toMatchObject({ countsTowardStatus: true, reason: 'default:push' });
    expect(byName(list, 'Launch Production')).toMatchObject({ countsTowardStatus: false, reason: 'default:excluded-manual' });

    // An override to main changes the answer.
    db.prepare("UPDATE repos SET default_branch_override = 'main' WHERE id = ?").run(repo.id);
    const overridden = db.prepare('SELECT * FROM repos WHERE id = ?').get(repo.id);
    expect(byName(workflowSelection.listRepoWorkflows(overridden), 'Launch Production').reason).toBe('default:push');
  });

  test('a repo with no effective branch reports default:unknown-branch', () => {
    const { db, workflowSelection } = load();
    seedCohorta(db);
    db.prepare('UPDATE repos SET default_branch = NULL').run();
    const repo = db.prepare('SELECT * FROM repos').get();
    const list = workflowSelection.listRepoWorkflows(repo);
    expect(byName(list, 'CI - Validate and Test')).toMatchObject({ countsTowardStatus: false, reason: 'default:unknown-branch' });
    expect(byName(list, 'Copilot').reason).toBe('default:excluded-managed');
  });

  describe('AC6: push evidence backfill', () => {
    test('a workflow with no push run in GAV is checked once; a push run found on GitHub is stored and counts', async () => {
      const { db, workflowSelection, listRuns } = load();
      const repo = seedCohorta(db);
      db.prepare('INSERT INTO workflows (id, name, owner_name, repo_name, path, state) VALUES (?, ?, ?, ?, ?, ?)')
        .run(5, 'Build Images', 'Think-Platinum', 'cohorta', '.github/workflows/build.yml', 'active');
      listRuns.mockImplementation(async (owner, name, workflowId) => ({
        workflow_runs: workflowId === 5
          ? [{ id: 777, workflow_id: 5, run_number: 9, status: 'completed', conclusion: 'success', event: 'push',
              head_branch: 'main', head_sha: 'abc1234', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:05:00Z' }]
          : [],
      }));

      const calls = await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 });

      // Candidates: Launch Production (manual only) and Build Images (no runs). Not CI (has push), Copilot (managed), Old Deploy (disabled).
      expect(calls).toBe(2);
      expect(listRuns.mock.calls.map(c => c[2]).sort()).toEqual([1, 5]);
      expect(listRuns).toHaveBeenCalledWith('Think-Platinum', 'cohorta', 5, { branch: 'main', event: 'push', per_page: 1 }, 'tok');
      const list = workflowSelection.listRepoWorkflows(repo);
      expect(byName(list, 'Build Images')).toMatchObject({ countsTowardStatus: true, reason: 'default:push' });
      expect(byName(list, 'Launch Production').reason).toBe('default:excluded-manual');

      // Checked once per branch: a second pass makes no calls.
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 })).toBe(0);
    });

    test('respects the shared budget and the rate-limit pause; a failed check is retried later', async () => {
      const { db, workflowSelection, listRuns, pause } = load();
      const repo = seedCohorta(db);
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      pause.mockReturnValue(true);
      listRuns.mockResolvedValue({ workflow_runs: [] });
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 })).toBe(0);
      expect(listRuns).not.toHaveBeenCalled();

      pause.mockReturnValue(false);
      const budget = { remaining: 0 };
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', budget)).toBe(0);

      listRuns.mockRejectedValue(new Error('502'));
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 })).toBe(1);
      listRuns.mockResolvedValue({ workflow_runs: [] });
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 })).toBe(1);
      expect(await workflowSelection.backfillPushEvidence(repo, 'tok', { remaining: 10 })).toBe(0);
    });
  });
});
