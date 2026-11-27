const { getDb } = require('../db/database');
const config = require('../config');
const githubApi = require('./githubApi');
const rateLimitTracker = require('./rateLimitTracker');

// How long GitHub's default branch is trusted before discovery re-reads it (#5).
const DEFAULT_BRANCH_TTL_MS = 60 * 60 * 1000;
const MAX_BRANCH_LENGTH = 255;

/**
 * Get all repos (including hidden).
 * @returns {Array<{id: number, owner: string, name: string, hidden: number, created_at: string}>}
 */
function getAllRepos() {
  const db = getDb();
  return db.prepare('SELECT * FROM repos ORDER BY owner, name').all();
}

/**
 * Get only visible (non-hidden) repos.
 * @returns {Array<{id: number, owner: string, name: string}>}
 */
function getVisibleRepos() {
  const db = getDb();
  return db.prepare('SELECT * FROM repos WHERE hidden = 0 ORDER BY owner, name').all();
}

/**
 * Add a repo (INSERT OR IGNORE to avoid duplicates).
 * @param {string} owner
 * @param {string} name
 * @returns {{id: number, owner: string, name: string, hidden: number, created_at: string}|null}
 */
function addRepo(owner, name) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO repos (owner, name) VALUES (@owner, @name)').run({ owner, name });
  return db.prepare('SELECT * FROM repos WHERE owner = @owner AND name = @name').get({ owner, name });
}

/**
 * Update a repo's hidden flag.
 * @param {number} id
 * @param {{ hidden: number }} data
 */
function updateRepo(id, data) {
  const db = getDb();
  if (data.hidden !== undefined) {
    db.prepare('UPDATE repos SET hidden = @hidden WHERE id = @id').run({ id, hidden: data.hidden ? 1 : 0 });
  }
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

/**
 * The branch status is computed on: the override, else GitHub's value, else
 * null. Never assumes `main` (#5).
 */
function effectiveDefaultBranch(repo) {
  return repo?.default_branch_override || repo?.default_branch || null;
}

/** API shape of a repo row: the raw columns plus camelCase branch fields. */
function toApi(repo) {
  if (!repo) return repo;
  return {
    ...repo,
    defaultBranch: repo.default_branch || null,
    defaultBranchOverride: repo.default_branch_override || null,
    effectiveDefaultBranch: effectiveDefaultBranch(repo),
    defaultBranchSyncedAt: repo.default_branch_synced_at || null,
  };
}

/**
 * Validate a branch override. Returns { value } (null clears) or { error }.
 */
function normaliseBranchOverride(input) {
  if (input === null || input === undefined) return { value: null };
  if (typeof input !== 'string') return { error: 'defaultBranchOverride must be a string or null' };
  const trimmed = input.trim();
  if (trimmed === '') return { value: null };
  if (trimmed.length > MAX_BRANCH_LENGTH || /[\s\x00-\x1f\x7f]/.test(trimmed)) {
    return { error: `defaultBranchOverride must be 1-${MAX_BRANCH_LENGTH} characters with no spaces` };
  }
  return { value: trimmed };
}

function setDefaultBranchOverride(id, value) {
  const db = getDb();
  db.prepare('UPDATE repos SET default_branch_override = @value WHERE id = @id').run({ id, value });
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

/**
 * Refresh GitHub's default branch for a repo when it has never been fetched,
 * is older than the TTL, or `force` is set. A failure or a rate-limit pause
 * keeps the stored value. Returns the (possibly updated) repo row.
 */
async function refreshDefaultBranch(repo, accessToken, { force = false, now = Date.now() } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM repos WHERE owner = ? AND name = ?').get(repo.owner, repo.name);
  if (!row) return null;
  const syncedAt = row.default_branch_synced_at ? Date.parse(row.default_branch_synced_at) : null;
  const fresh = row.default_branch && syncedAt !== null && now - syncedAt < DEFAULT_BRANCH_TTL_MS;
  if ((fresh && !force) || rateLimitTracker.shouldPause()) return row;
  try {
    const data = await githubApi.getRepo(row.owner, row.name, accessToken);
    if (typeof data?.default_branch === 'string' && data.default_branch) {
      db.prepare('UPDATE repos SET default_branch = ?, default_branch_synced_at = ? WHERE id = ?')
        .run(data.default_branch, new Date(now).toISOString(), row.id);
    }
  } catch (err) {
    console.warn(`[repos] ${row.owner}/${row.name}: could not read default branch: ${err.message}`);
  }
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(row.id);
}

/**
 * Delete a repo and all its associated data.
 * @param {number} id
 */
function deleteRepo(id) {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
  if (!repo) return false;

  // Delete associated data
  db.prepare(`
    DELETE FROM workflow_jobs WHERE run_id IN (
      SELECT id FROM workflow_runs WHERE owner_name = @owner AND repo_name = @name
    )
  `).run({ owner: repo.owner, name: repo.name });
  db.prepare('DELETE FROM workflow_runs WHERE owner_name = @owner AND repo_name = @name').run({ owner: repo.owner, name: repo.name });
  db.prepare('DELETE FROM workflows WHERE owner_name = @owner AND repo_name = @name').run({ owner: repo.owner, name: repo.name });
  db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  return true;
}

/**
 * Seed repos table from environment config (INSERT OR IGNORE).
 * Called on startup so env var repos are always present.
 */
function syncReposFromConfig() {
  const db = getDb();
  const stmt = db.prepare('INSERT OR IGNORE INTO repos (owner, name) VALUES (@owner, @name)');
  const insertMany = db.transaction((repos) => {
    for (const repo of repos) {
      stmt.run({ owner: repo.owner, name: repo.name });
    }
  });
  insertMany(config.repos);
}

module.exports = {
  getAllRepos,
  getVisibleRepos,
  addRepo,
  updateRepo,
  deleteRepo,
  syncReposFromConfig,
  effectiveDefaultBranch,
  toApi,
  normaliseBranchOverride,
  setDefaultBranchOverride,
  refreshDefaultBranch,
  DEFAULT_BRANCH_TTL_MS,
};
