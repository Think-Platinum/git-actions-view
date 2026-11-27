const http = require('http');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

// #9: /api/v1/events accepts read-only tokens, revoking a token ends its
// streams, and each token may hold at most 5 streams.

const testDbPath = path.join(__dirname, 'test-events-tokens.sqlite');
const ORIGIN = 'http://gav.local:9000';

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const apiTokens = require('../src/services/apiTokens');
    const sseManager = require('../src/services/sseManager');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const signedIn = req.headers['x-test-session'] === '1';
      req.isAuthenticated = () => signedIn;
      if (signedIn) req.user = { login: 'owner' };
      next();
    });
    app.use(require('../src/routes/tokens'));
    app.use(require('../src/routes/sse'));
    mods = { app, apiTokens, sseManager };
  });
  return mods;
}

/** Open a stream; resolves once the first bytes arrive (or a non-200 status). */
function openStream(port, headers = {}) {
  return new Promise((resolve, reject) => {
    // agent: false - no pooled keep-alive sockets. A pooled socket to this
    // test's server could otherwise be reused by a later test in the same
    // worker whose server gets the same port, and reach the wrong app.
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events', headers, agent: false }, res => {
      const ended = new Promise(done => res.on('end', done).on('close', done));
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode, ended, req });
      }
      res.once('data', () => resolve({ status: 200, ended, req }));
    });
    req.on('error', reject);
  });
}

const within = (promise, ms) =>
  Promise.race([promise.then(() => true), new Promise(r => setTimeout(() => r(false), ms))]);

describe('/api/v1/events with API tokens (#9)', () => {
  const originalEnv = { ...process.env };
  let server;
  let streams;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GITHUB_OAUTH2_CLIENT_ID = 'id';
    process.env.GITHUB_OAUTH2_CLIENT_SECRET = 'secret';
    process.env.BASE_URL = ORIGIN;
    process.env.DB_PATH = testDbPath;
    for (const s of ['', '-shm', '-wal']) if (fs.existsSync(testDbPath + s)) fs.unlinkSync(testDbPath + s);
    streams = [];
  });

  afterEach(async () => {
    for (const s of streams) s.req.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
    server = null;
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

  async function start() {
    const mods = load();
    server = mods.app.listen(0);
    await new Promise(r => server.once('listening', r));
    return { ...mods, port: server.address().port };
  }

  async function stream(port, headers) {
    const s = await openStream(port, headers);
    streams.push(s);
    return s;
  }

  test('AC1: a valid token can open the event stream; no credential gets 401', async () => {
    const { port, apiTokens, sseManager } = await start();
    const { token, id } = apiTokens.createToken('wled');
    const ok = await stream(port, { Authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(sseManager.countClientsForToken(id)).toBe(1);
    expect((await stream(port, {})).status).toBe(401);
    expect((await stream(port, { Authorization: 'Bearer gav_nope' })).status).toBe(401);
  });

  test('AC3: revoking a token ends its open streams, and only its own', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { app, port, apiTokens, sseManager } = await start();
    const a = apiTokens.createToken('agent-a');
    const b = apiTokens.createToken('agent-b');
    const streamA = await stream(port, { Authorization: `Bearer ${a.token}` });
    const streamB = await stream(port, { Authorization: `Bearer ${b.token}` });
    expect(sseManager.getClientCount()).toBe(2);

    const revoked = await request(app)
      .delete(`/api/v1/tokens/${a.id}`)
      .set('x-test-session', '1')
      .set('Origin', ORIGIN);
    expect(revoked.status).toBe(204);

    expect(await within(streamA.ended, 1000)).toBe(true);
    expect(await within(streamB.ended, 200)).toBe(false);
    expect(sseManager.countClientsForToken(a.id)).toBe(0);
    expect(sseManager.countClientsForToken(b.id)).toBe(1);

    // And the revoked token cannot reconnect.
    expect((await stream(port, { Authorization: `Bearer ${a.token}` })).status).toBe(401);
  });

  test('AC4: a sixth concurrent stream for one token gets 429; other tokens are unaffected', async () => {
    const { port, apiTokens } = await start();
    const a = apiTokens.createToken('agent-a');
    const b = apiTokens.createToken('agent-b');
    for (let i = 0; i < 5; i++) {
      expect((await stream(port, { Authorization: `Bearer ${a.token}` })).status).toBe(200);
    }
    expect((await stream(port, { Authorization: `Bearer ${a.token}` })).status).toBe(429);
    expect((await stream(port, { Authorization: `Bearer ${b.token}` })).status).toBe(200);
  });

  test('a closed stream frees its slot', async () => {
    const { port, apiTokens, sseManager } = await start();
    const a = apiTokens.createToken('agent-a');
    const first = await stream(port, { Authorization: `Bearer ${a.token}` });
    first.req.destroy();
    await within(first.ended, 1000);
    for (let i = 0; i < 50 && sseManager.countClientsForToken(a.id) > 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(sseManager.countClientsForToken(a.id)).toBe(0);
  });

  test('session callers are not capped', async () => {
    const { port } = await start();
    for (let i = 0; i < 6; i++) {
      expect((await stream(port, { 'x-test-session': '1' })).status).toBe(200);
    }
  });
});
