const express = require('express');
const config = require('../config');
const { ensureAuthenticated } = require('../auth/middleware');
const apiTokens = require('../services/apiTokens');

// Token management (#9). Session-only: these routes use ensureAuthenticated,
// never allowApiToken, so a token cannot mint, list or revoke tokens.

const router = express.Router();

function requireAuthEnabled(req, res, next) {
  if (!config.isAuthRequired) {
    return res.status(409).json({ error: 'API tokens are only available when authentication is enabled' });
  }
  next();
}

// Cross-site guard for state-changing calls. With the default sameSite=lax
// cookie a cross-site POST carries no session anyway; with COOKIE_SAME_SITE=none
// it would, so a foreign or (in that mode) missing Origin is refused.
function requireSameOrigin(req, res, next) {
  const expected = new URL(config.baseUrl).origin;
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {
      origin = 'invalid';
    }
  }
  if (origin ? origin !== expected : config.cookieSameSite === 'none') {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  next();
}

function auditLog(action, req, record) {
  // Never log the token or its hash.
  const actor = req.user?.login || 'unknown';
  console.log(`[tokens] ${action} id=${record.id} name="${record.name}" prefix=${record.prefix} by=${actor}`);
}

router.get('/api/v1/tokens', requireAuthEnabled, ensureAuthenticated, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ tokens: apiTokens.listTokens() });
});

router.post('/api/v1/tokens', requireAuthEnabled, ensureAuthenticated, requireSameOrigin, (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > apiTokens.MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `name must be 1-${apiTokens.MAX_NAME_LENGTH} characters` });
  }
  const created = apiTokens.createToken(name, req.user?.login || null);
  auditLog('created', req, created);
  res.set('Cache-Control', 'no-store');
  res.status(201).json(created);
});

router.delete('/api/v1/tokens/:id', requireAuthEnabled, ensureAuthenticated, requireSameOrigin, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid token id' });
  }
  const id = Number(req.params.id);
  const record = apiTokens.listTokens().find(t => t.id === id);
  if (!record || !apiTokens.revokeToken(id)) {
    return res.status(404).json({ error: 'Token not found' });
  }
  auditLog('revoked', req, record);
  res.status(204).end();
});

module.exports = router;
