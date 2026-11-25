const config = require('../config');
const { verifyToken } = require('../services/apiTokens');

/**
 * Session-only guard. Used by every route that has not opted in to API tokens,
 * so a bearer token alone never gets past it.
 */
function ensureAuthenticated(req, res, next) {
  if (!config.isAuthRequired) {
    return next();
  }
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Opt-in guard for routes that headless clients may call with a read-only API
 * token (#9). Token eligibility is declared per route: a route that does not
 * mount this middleware stays session-only by default.
 *
 * - Auth disabled: unchanged, everything passes and tokens are ignored.
 * - An Authorization header is present: it must be a valid `Bearer gav_...`
 *   token, otherwise 401. A bad bearer never falls back to the session.
 * - No Authorization header: the normal session check applies.
 *
 * Tokens are read only from the header, never from the query string.
 */
function allowApiToken(req, res, next) {
  if (!config.isAuthRequired) {
    return next();
  }
  const header = req.headers?.authorization;
  if (header === undefined) {
    return ensureAuthenticated(req, res, next);
  }
  const match = /^Bearer\s+(\S+)$/i.exec(String(header).trim());
  const principal = match ? verifyToken(match[1]) : null;
  if (!principal) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.apiToken = principal;
  return next();
}

function getAccessToken(req) {
  // A token principal is a headless client and never holds a GitHub
  // credential, so it must not inherit the server's token (#9).
  if (req.apiToken) {
    return null;
  }
  if (req.user?.accessToken) {
    return req.user.accessToken;
  }
  return config.githubAccessToken || null;
}

module.exports = { ensureAuthenticated, allowApiToken, getAccessToken };
