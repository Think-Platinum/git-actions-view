const express = require('express');
const { allowApiToken } = require('../auth/middleware');
const { resolveFailures, MAX_BATCH } = require('../services/resolveService');

const router = express.Router();

/**
 * POST /api/v1/state/resolve (#11). Read-only despite the method: a batch body
 * is simpler than a list in a query string. Opts in to read-only API tokens.
 * Contract: docs/state-resolve-api.md.
 */
router.post('/api/v1/state/resolve', allowApiToken, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const failures = req.body?.failures;
  if (!Array.isArray(failures)) {
    return res.status(400).json({ error: 'Body must be { "failures": [...] }' });
  }
  if (failures.length > MAX_BATCH) {
    return res.status(400).json({ error: `At most ${MAX_BATCH} failures per request` });
  }
  try {
    res.json({ results: await resolveFailures(failures) });
  } catch (err) {
    console.error(`[resolve] request failed: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
