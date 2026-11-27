const express = require('express');
const { allowApiToken, apiTokenRateLimit } = require('../auth/middleware');
const { computeStatus } = require('../services/statusService');

const router = express.Router();

/**
 * GET /api/v1/status (#7): per-repository queued / building / failing flags
 * and build progress. Opts in to read-only API tokens. Contract:
 * docs/status-api.md.
 */
router.get('/api/v1/status', apiTokenRateLimit, allowApiToken, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(computeStatus());
  } catch (err) {
    console.error(`[status] failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
