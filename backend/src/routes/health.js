const express = require('express');
const database = require('../db/database');
const { publicRateLimit } = require('../auth/middleware');
const { version } = require('../../package.json');

const router = express.Router();
const startedAt = new Date();

/**
 * GET /api/health (#20): liveness and the running version, for debugging.
 * Unauthenticated, so it reports nothing beyond status, version and uptime.
 * The version is the backend package.json version, which CI checks against
 * the release tag.
 */
router.get('/api/health', publicRateLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  let ok = false;
  try {
    ok = database.getDb().prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    ok = false;
  }
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    version,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  });
});

module.exports = router;
