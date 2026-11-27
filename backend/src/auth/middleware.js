const { rateLimit } = require('express-rate-limit');
const config = require('../config');
const { verifyToken } = require('../services/apiTokens');

const TOO_MANY = { error: 'Too many requests' };

/**
 * Per-client limit for routes that accept API tokens (#9). Mount it before
 * allowApiToken on every opted-in route, so repeated bad tokens are throttled
 * before any lookup. Generous enough for polling clients.
 */
const apiTokenRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: TOO_MANY,
});

/**
 * General per-client limit for session routes added since #6 (settings-style
 * reads and writes). Generous for interactive use.
 */
const sessionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: TOO_MANY,
});

/** Stricter limit for token management (create, list, revoke). */
const tokenAdminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: TOO_MANY,
});

/**
 * CSRF protection for state-changing, cookie-authenticated routes, by Origin
 * check. With the default sameSite=lax cookie a cross-site POST carries no
 * session anyway; with COOKIE_SAME_SITE=none it would, so a foreign Origin (or
 * Referer) is refused, and in that mode a missing one too.
 *
 * A request already authenticated by bearer token (req.apiToken, set by
 * allowApiToken) is skipped: browsers never attach that header cross-site.
 */
function csrfProtection(req, res, next) {
  if (req.apiToken) {
    return next();
  }
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

module.exports = {
  ensureAuthenticated,
  allowApiToken,
  apiTokenRateLimit,
  tokenAdminRateLimit,
  sessionRateLimit,
  csrfProtection,
  getAccessToken,
};
