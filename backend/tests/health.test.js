const request = require('supertest');
const fs = require('fs');
const path = require('path');

// GET /api/health (#20): liveness and the running version.

const testDbPath = path.join(__dirname, 'test-health.sqlite');
const root = path.join(__dirname, '..', '..');
const readVersion = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version;

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const database = require('../src/db/database');
    const app = express();
    app.use(require('../src/routes/health'));
    mods = { app, database };
  });
  return mods;
}

describe('GET /api/health (#20)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Auth enabled: health must still answer without a session or token.
    process.env.GITHUB_OAUTH2_CLIENT_ID = 'id';
    process.env.GITHUB_OAUTH2_CLIENT_SECRET = 'secret';
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

  test('AC1: reports ok and the backend package.json version without credentials', async () => {
    const { app } = load();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe(readVersion('backend/package.json'));
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('AC2: a failing database gives 503 degraded, still with the version and no error text', async () => {
    const { app, database } = load();
    jest.spyOn(database, 'getDb').mockImplementation(() => {
      throw new Error('SQLITE_CANTOPEN: /secret/path/db');
    });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.version).toBe(readVersion('backend/package.json'));
    expect(JSON.stringify(res.body)).not.toMatch(/SQLITE|secret|path/i);
  });

  test('AC3: exactly status, version, startedAt and uptimeSeconds, not cacheable', async () => {
    const { app } = load();
    const res = await request(app).get('/api/health');
    expect(Object.keys(res.body).sort()).toEqual(['startedAt', 'status', 'uptimeSeconds', 'version']);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Number.isInteger(res.body.uptimeSeconds)).toBe(true);
    expect(Date.parse(res.body.startedAt)).not.toBeNaN();
  });

  test('AC4: root, backend and frontend package.json versions agree', () => {
    const versions = ['package.json', 'backend/package.json', 'frontend/package.json'].map(readVersion);
    expect(new Set(versions).size).toBe(1);
  });
});
