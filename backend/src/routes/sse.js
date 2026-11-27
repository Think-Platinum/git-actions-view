const express = require('express');
const { allowApiToken, apiTokenRateLimit } = require('../auth/middleware');
const { addClient, countClientsForToken } = require('../services/sseManager');

const router = express.Router();

// Concurrent event streams allowed per API token (#9).
const MAX_STREAMS_PER_TOKEN = 5;

/**
 * GET /api/v1/events — SSE stream for real-time sync updates.
 * Opts in to read-only API tokens (#9). Revoking a token ends its streams.
 */
router.get('/api/v1/events', apiTokenRateLimit, allowApiToken, (req, res) => {
  const tokenId = req.apiToken?.id ?? null;
  if (tokenId !== null && countClientsForToken(tokenId) >= MAX_STREAMS_PER_TOKEN) {
    return res.status(429).json({ error: `At most ${MAX_STREAMS_PER_TOKEN} event streams per token` });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial keepalive
  res.write(':ok\n\n');

  addClient(res, { tokenId });

  // Keepalive every 30 seconds to prevent proxy timeouts
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepalive);
  });
  res.on('close', () => {
    clearInterval(keepalive);
  });
});

module.exports = router;
module.exports.MAX_STREAMS_PER_TOKEN = MAX_STREAMS_PER_TOKEN;
