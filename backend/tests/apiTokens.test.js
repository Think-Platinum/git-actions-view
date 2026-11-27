const request = require('supertest');
const fs = require('fs');
const path = require('path');

// #9 backend slice: token store, opt-in allowApiToken middleware and
// session-only token management routes.

const testDbPath = path.join(__dirname, 'test-api-tokens.sqlite');

function load() {
  let mods;
  jest.isolateModules(() => {
    process.env.DB_PATH = testDbPath;
    const express = require('express');
    const { ensureAuthenticated, allowApiToken, apiTokenRateLimit } = require('../src/auth/middleware');
    const apiTokens = require('../src/services/apiTokens');
    const { getDb } = require('../src/db/database');

    const app = express();
    app.use(express.json());
    // Test stand-in for passport: the x-test-session header marks a signed-in
    // browser session.
    app.use((req, res, next) => {
      const signedIn = req.headers['x-test-session'] === '1';
      req.isAuthenticated = () => signedIn;
      if (signedIn) req.user = { login: 'owner' };
      next();
    });
    app.use(require('../src/routes/tokens'));
    app.use(require('../src/routes/runs'));
    app.get('/test/token-eligible', apiTokenRateLimit, allowApiToken, (req, res) => {
      res.json({ apiToken: req.apiToken || null });
    });
    app.post('/test/token-eligible', apiTokenRateLimit, allowApiToken, (req, res) => res.json({ ok: true }));
    app.get('/test/session-only', apiTokenRateLimit, ensureAuthenticated, (req, res) => res.json({ ok: true }));

    mods = { app, apiTokens, getDb };
  });
  return mods;
}

describe('API tokens (#9 backend slice)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GITHUB_OAUTH2_CLIENT_ID = 'id';
    process.env.GITHUB_OAUTH2_CLIENT_SECRET = 'secret';
    delete process.env.BASIC_AUTH_USER_DETAILS_FILE_PATH;
    delete process.env.COOKIE_SAME_SITE;
    process.env.BASE_URL = 'http://gav.local:9000';
    process.env.DB_PATH = testDbPath;
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
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

  describe('token store', () => {
    test('returns the token once and stores only its hash', () => {
      const { apiTokens, getDb } = load();
      const created = apiTokens.createToken('auden', 'owner');
      expect(created.token).toMatch(/^gav_[A-Za-z0-9_-]{43}$/);
      expect(created.prefix).toBe(created.token.slice(0, 8));

      const row = getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(created.id);
      expect(row.token_hash).toBe(apiTokens.hashToken(created.token));
      expect(JSON.stringify(row)).not.toContain(created.token);

      const listed = apiTokens.listTokens();
      expect(listed).toHaveLength(1);
      expect(listed[0].token).toBeUndefined();
      expect(JSON.stringify(listed)).not.toContain(row.token_hash);
    });

    test('verifies valid tokens and rejects revoked, unknown and malformed ones', () => {
      const { apiTokens } = load();
      const created = apiTokens.createToken('auden');
      expect(apiTokens.verifyToken(created.token)).toEqual({ id: created.id, name: 'auden' });
      expect(apiTokens.verifyToken('gav_' + 'x'.repeat(43))).toBeNull();
      expect(apiTokens.verifyToken('not-a-token')).toBeNull();
      apiTokens.revokeToken(created.id);
      expect(apiTokens.verifyToken(created.token)).toBeNull();
    });

    test('records last use at most once a minute', () => {
      const { apiTokens, getDb } = load();
      const created = apiTokens.createToken('auden');
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(Date.parse('2026-11-25T07:30:00Z'));
      apiTokens.verifyToken(created.token);
      now.mockReturnValue(Date.parse('2026-11-25T07:30:30Z'));
      apiTokens.verifyToken(created.token);
      const lastUsed = () => getDb().prepare('SELECT last_used_at FROM api_tokens').get().last_used_at;
      expect(lastUsed()).toBe('2026-11-25T07:30:00.000Z');
      now.mockReturnValue(Date.parse('2026-11-25T07:31:30Z'));
      apiTokens.verifyToken(created.token);
      expect(lastUsed()).toBe('2026-11-25T07:31:30.000Z');
    });
  });

  describe('allowApiToken', () => {
    test('a valid token can call an opted-in route, with any method', async () => {
      const { app, apiTokens } = load();
      const { token, id } = apiTokens.createToken('auden');
      const get = await request(app).get('/test/token-eligible').set('Authorization', `Bearer ${token}`);
      expect(get.status).toBe(200);
      expect(get.body.apiToken).toEqual({ id, name: 'auden' });
      const post = await request(app).post('/test/token-eligible').set('Authorization', `bearer ${token}`);
      expect(post.status).toBe(200);
    });

    test('revoked, unknown and malformed tokens get 401', async () => {
      const { app, apiTokens } = load();
      const { token, id } = apiTokens.createToken('auden');
      apiTokens.revokeToken(id);
      for (const header of [`Bearer ${token}`, 'Bearer gav_unknown', 'Basic abc', 'Bearer']) {
        const res = await request(app).get('/test/token-eligible').set('Authorization', header);
        expect(res.status).toBe(401);
      }
    });

    test('an invalid bearer never falls back to the session', async () => {
      const { app } = load();
      const res = await request(app)
        .get('/test/token-eligible')
        .set('x-test-session', '1')
        .set('Authorization', 'Bearer gav_bad');
      expect(res.status).toBe(401);
    });

    test('without a bearer the session check applies', async () => {
      const { app } = load();
      expect((await request(app).get('/test/token-eligible')).status).toBe(401);
      expect((await request(app).get('/test/token-eligible').set('x-test-session', '1')).status).toBe(200);
    });

    test('a token in the query string is not accepted', async () => {
      const { app, apiTokens } = load();
      const { token } = apiTokens.createToken('auden');
      const res = await request(app).get(`/test/token-eligible?token=${token}`);
      expect(res.status).toBe(401);
    });

    test('routes that have not opted in stay session-only', async () => {
      const { app, apiTokens } = load();
      const { token } = apiTokens.createToken('auden');
      for (const url of ['/test/session-only', '/api/v1/runs', '/api/v1/tokens']) {
        const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(401);
      }
    });

    test('auth disabled: behaviour unchanged, tokens ignored', async () => {
      delete process.env.GITHUB_OAUTH2_CLIENT_ID;
      delete process.env.GITHUB_OAUTH2_CLIENT_SECRET;
      const { app } = load();
      const res = await request(app).get('/test/token-eligible').set('Authorization', 'Bearer gav_bad');
      expect(res.status).toBe(200);
      expect(res.body.apiToken).toBeNull();
    });
  });

  describe('rate limits', () => {
    test('token-eligible routes throttle a client after 120 requests a minute, before any lookup', async () => {
      const { app } = load();
      for (let i = 0; i < 120; i++) {
        const res = await request(app).get('/test/token-eligible').set('Authorization', 'Bearer gav_guess');
        expect(res.status).toBe(401);
      }
      const limited = await request(app).get('/test/token-eligible').set('Authorization', 'Bearer gav_guess');
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: 'Too many requests' });
    }, 20000); // 121 sequential requests can exceed the 5 s default under a parallel run

    test('token management throttles a client after 30 requests in 15 minutes', async () => {
      const { app } = load();
      for (let i = 0; i < 30; i++) {
        expect((await request(app).get('/api/v1/tokens').set('x-test-session', '1')).status).toBe(200);
      }
      expect((await request(app).get('/api/v1/tokens').set('x-test-session', '1')).status).toBe(429);
    }, 20000);
  });

  describe('csrfProtection', () => {
    function check(req) {
      let csrfProtection;
      jest.isolateModules(() => {
        ({ csrfProtection } = require('../src/auth/middleware'));
      });
      const next = jest.fn();
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }) };
      csrfProtection({ headers: {}, ...req }, res, next);
      return next.mock.calls.length ? 'passed' : res.status.mock.calls[0][0];
    }

    test('refuses a foreign Origin or Referer and accepts the configured one', () => {
      expect(check({ headers: { origin: 'https://evil.example' } })).toBe(403);
      expect(check({ headers: { referer: 'https://evil.example/page' } })).toBe(403);
      expect(check({ headers: { origin: 'http://gav.local:9000' } })).toBe('passed');
      expect(check({ headers: {} })).toBe('passed');
    });

    test('with sameSite=none a missing Origin is refused, unless the caller used a bearer token', () => {
      process.env.COOKIE_SAME_SITE = 'none';
      expect(check({ headers: {} })).toBe(403);
      expect(check({ headers: {}, apiToken: { id: 1, name: 'auden' } })).toBe('passed');
    });
  });

  describe('getAccessToken', () => {
    test('returns null for a token principal, even with a server token', () => {
      process.env.GITHUB_ACCESS_TOKEN = 'server-token';
      let getAccessToken;
      jest.isolateModules(() => {
        ({ getAccessToken } = require('../src/auth/middleware'));
      });
      expect(getAccessToken({ apiToken: { id: 1, name: 'auden' } })).toBeNull();
      expect(getAccessToken({})).toBe('server-token');
    });
  });

  describe('token management routes', () => {
    const origin = 'http://gav.local:9000';

    test('create, list and revoke with a session', async () => {
      const { app } = load();
      const created = await request(app)
        .post('/api/v1/tokens')
        .set('x-test-session', '1')
        .set('Origin', origin)
        .send({ name: '  auden  ' });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('auden');
      expect(created.body.createdBy).toBe('owner');
      expect(created.body.token).toMatch(/^gav_/);

      const list = await request(app).get('/api/v1/tokens').set('x-test-session', '1');
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(list.body.tokens).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(created.body.token);

      const revoked = await request(app)
        .delete(`/api/v1/tokens/${created.body.id}`)
        .set('x-test-session', '1')
        .set('Origin', origin);
      expect(revoked.status).toBe(204);

      const used = await request(app).get('/test/token-eligible').set('Authorization', `Bearer ${created.body.token}`);
      expect(used.status).toBe(401);
    });

    test('a token cannot manage tokens', async () => {
      const { app, apiTokens } = load();
      const { token, id } = apiTokens.createToken('auden');
      const auth = { Authorization: `Bearer ${token}`, Origin: origin };
      expect((await request(app).post('/api/v1/tokens').set(auth).send({ name: 'x' })).status).toBe(401);
      expect((await request(app).delete(`/api/v1/tokens/${id}`).set(auth)).status).toBe(401);
    });

    test('foreign origins are refused, and a missing origin when sameSite=none', async () => {
      const { app } = load();
      const foreign = await request(app)
        .post('/api/v1/tokens')
        .set('x-test-session', '1')
        .set('Origin', 'https://evil.example')
        .send({ name: 'x' });
      expect(foreign.status).toBe(403);

      process.env.COOKIE_SAME_SITE = 'none';
      const { app: noneApp } = load();
      const missing = await request(noneApp).post('/api/v1/tokens').set('x-test-session', '1').send({ name: 'x' });
      expect(missing.status).toBe(403);
    });

    test('validates names and ids', async () => {
      const { app } = load();
      const base = request(app);
      expect((await base.post('/api/v1/tokens').set('x-test-session', '1').send({ name: ' ' })).status).toBe(400);
      expect((await base.post('/api/v1/tokens').set('x-test-session', '1').send({ name: 'x'.repeat(101) })).status).toBe(400);
      expect((await base.delete('/api/v1/tokens/abc').set('x-test-session', '1')).status).toBe(400);
      expect((await base.delete('/api/v1/tokens/999').set('x-test-session', '1')).status).toBe(404);
    });

    test('return 409 when auth is disabled', async () => {
      delete process.env.GITHUB_OAUTH2_CLIENT_ID;
      delete process.env.GITHUB_OAUTH2_CLIENT_SECRET;
      const { app } = load();
      expect((await request(app).get('/api/v1/tokens')).status).toBe(409);
      expect((await request(app).post('/api/v1/tokens').send({ name: 'x' })).status).toBe(409);
    });

    test('the token value is never logged', async () => {
      const spies = ['log', 'info', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
      const { app } = load();
      const created = await request(app)
        .post('/api/v1/tokens')
        .set('x-test-session', '1')
        .set('Origin', origin)
        .send({ name: 'auden' });
      const token = created.body.token;
      await request(app).get('/test/token-eligible').set('Authorization', `Bearer ${token}`);
      await request(app).delete(`/api/v1/tokens/${created.body.id}`).set('x-test-session', '1').set('Origin', origin);
      await request(app).get('/test/token-eligible').set('Authorization', `Bearer ${token}`);

      const logged = spies.flatMap(s => s.mock.calls.flat()).map(String).join('\n');
      expect(logged).toContain('[tokens] created');
      expect(logged).toContain('[tokens] revoked');
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(token.slice(8));
    });
  });
});
