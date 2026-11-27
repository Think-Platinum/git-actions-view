const request = require('supertest');
const fs = require('fs');
const path = require('path');

// #5: store and configure each repository's default branch.

jest.mock('../src/services/syncDispatcher', () => ({
  syncSingleRepo: jest.fn(),
}));

const testDbPath = path.join(__dirname, 'test-default-branch.sqlite');

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const githubApi = require('../src/services/githubApi');
    const rateLimitTracker = require('../src/services/rateLimitTracker');
    const reposService = require('../src/services/reposService');
    const { getDb } = require('../src/db/database');
    const { runMigrations } = require('../src/db/migrations');
    const app = express();
    app.use(express.json());
    app.use(require('../src/routes/repos'));
    const getRepo = jest.spyOn(githubApi, 'getRepo');
    const pause = jest.spyOn(rateLimitTracker, 'shouldPause').mockReturnValue(false);
    mods = { app, reposService, getRepo, pause, db: getDb(), runMigrations };
  });
  return mods;
}

describe('default branch (#5)', () => {
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

  const getRepoRow = async (app, name = 'repo') =>
    (await request(app).get('/api/v1/repos')).body.repos.find(r => r.name === name);

  test('AC1: a sync stores GitHub\'s value; a develop repo reports develop', async () => {
    const { app, reposService, getRepo } = load();
    reposService.addRepo('org', 'repo');
    getRepo.mockResolvedValue({ default_branch: 'develop' });

    await reposService.refreshDefaultBranch({ owner: 'org', name: 'repo' }, 'tok');

    expect(getRepo).toHaveBeenCalledWith('org', 'repo', 'tok');
    const repo = await getRepoRow(app);
    expect(repo).toMatchObject({
      defaultBranch: 'develop',
      defaultBranchOverride: null,
      effectiveDefaultBranch: 'develop',
    });
    expect(repo.defaultBranchSyncedAt).toEqual(expect.any(String));
  });

  test('AC2: an override wins, and clearing it falls back to GitHub\'s value', async () => {
    const { app, reposService, getRepo } = load();
    const { id } = reposService.addRepo('org', 'repo');
    getRepo.mockResolvedValue({ default_branch: 'main' });
    await reposService.refreshDefaultBranch({ owner: 'org', name: 'repo' }, 'tok');

    const set = await request(app).put(`/api/v1/repos/${id}`).send({ defaultBranchOverride: '  release/2026  ' });
    expect(set.status).toBe(200);
    expect(set.body.repo).toMatchObject({ defaultBranchOverride: 'release/2026', effectiveDefaultBranch: 'release/2026' });

    const cleared = await request(app).put(`/api/v1/repos/${id}`).send({ defaultBranchOverride: null });
    expect(cleared.body.repo).toMatchObject({ defaultBranchOverride: null, effectiveDefaultBranch: 'main' });

    await request(app).put(`/api/v1/repos/${id}`).send({ defaultBranchOverride: 'x' });
    const emptied = await request(app).put(`/api/v1/repos/${id}`).send({ defaultBranchOverride: '' });
    expect(emptied.body.repo.effectiveDefaultBranch).toBe('main');
  });

  test('AC3: a repo that has never synced reports null, never main', async () => {
    const { app, reposService } = load();
    reposService.addRepo('org', 'repo');
    const repo = await getRepoRow(app);
    expect(repo.effectiveDefaultBranch).toBeNull();
    expect(repo.defaultBranch).toBeNull();
    expect(reposService.effectiveDefaultBranch({})).toBeNull();
  });

  test('override validation: rejects spaces, control characters and over-long names; hidden still works', async () => {
    const { app, reposService } = load();
    const { id } = reposService.addRepo('org', 'repo');
    for (const bad of ['has space', 'tab\there', 'x'.repeat(256), 42]) {
      const res = await request(app).put(`/api/v1/repos/${id}`).send({ defaultBranchOverride: bad });
      expect(res.status).toBe(400);
    }
    const hidden = await request(app).put(`/api/v1/repos/${id}`).send({ hidden: true });
    expect(hidden.status).toBe(200);
    expect(hidden.body.repo.hidden).toBe(1);
    expect((await request(app).put('/api/v1/repos/9999').send({ defaultBranchOverride: 'x' })).status).toBe(404);
  });

  test('refresh policy: fresh values are not re-read; stale ones are; force always re-reads', async () => {
    const { reposService, getRepo } = load();
    reposService.addRepo('org', 'repo');
    getRepo.mockResolvedValue({ default_branch: 'main' });
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    const repo = { owner: 'org', name: 'repo' };

    await reposService.refreshDefaultBranch(repo, 'tok', { now: t0 });
    await reposService.refreshDefaultBranch(repo, 'tok', { now: t0 + 30 * 60 * 1000 });
    expect(getRepo).toHaveBeenCalledTimes(1);

    getRepo.mockResolvedValue({ default_branch: 'trunk' });
    const after = await reposService.refreshDefaultBranch(repo, 'tok', { now: t0 + 61 * 60 * 1000 });
    expect(getRepo).toHaveBeenCalledTimes(2);
    expect(after.default_branch).toBe('trunk');

    await reposService.refreshDefaultBranch(repo, 'tok', { now: t0 + 62 * 60 * 1000, force: true });
    expect(getRepo).toHaveBeenCalledTimes(3);
  });

  test('a failed fetch or a rate-limit pause keeps the stored value', async () => {
    const { reposService, getRepo, pause } = load();
    reposService.addRepo('org', 'repo');
    getRepo.mockResolvedValue({ default_branch: 'main' });
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    await reposService.refreshDefaultBranch({ owner: 'org', name: 'repo' }, 'tok', { now: t0 });

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    getRepo.mockRejectedValue(new Error('502'));
    const failed = await reposService.refreshDefaultBranch({ owner: 'org', name: 'repo' }, 'tok', { now: t0 + 2 * 3600e3 });
    expect(failed.default_branch).toBe('main');

    pause.mockReturnValue(true);
    getRepo.mockClear();
    const paused = await reposService.refreshDefaultBranch({ owner: 'org', name: 'repo' }, 'tok', { now: t0 + 3 * 3600e3 });
    expect(getRepo).not.toHaveBeenCalled();
    expect(paused.default_branch).toBe('main');
  });

  test('AC4: running the migrations again leaves existing rows intact', async () => {
    const { reposService, db, runMigrations } = load();
    const { id } = reposService.addRepo('org', 'repo');
    db.prepare("UPDATE repos SET default_branch = 'develop', default_branch_override = 'x', hidden = 1 WHERE id = ?").run(id);
    runMigrations(db);
    runMigrations(db);
    const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
    expect(row).toMatchObject({ owner: 'org', name: 'repo', hidden: 1, default_branch: 'develop', default_branch_override: 'x' });
  });
});
