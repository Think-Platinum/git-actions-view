function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_name  TEXT NOT NULL,
      repo_name   TEXT NOT NULL,
      path        TEXT,
      state       TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id               INTEGER PRIMARY KEY,
      workflow_id      INTEGER NOT NULL REFERENCES workflows(id),
      owner_name       TEXT NOT NULL,
      repo_name        TEXT NOT NULL,
      workflow_name    TEXT NOT NULL,
      run_number       INTEGER NOT NULL,
      status           TEXT NOT NULL,
      conclusion       TEXT,
      event            TEXT,
      branch           TEXT,
      actor_login      TEXT,
      actor_avatar_url TEXT,
      html_url         TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      run_started_at   TEXT,
      run_attempt      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS workflow_jobs (
      id               INTEGER PRIMARY KEY,
      run_id           INTEGER NOT NULL REFERENCES workflow_runs(id),
      name             TEXT NOT NULL,
      status           TEXT NOT NULL,
      conclusion       TEXT,
      started_at       TEXT,
      completed_at     TEXT,
      html_url         TEXT,
      runner_name      TEXT,
      run_attempt      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      owner      TEXT NOT NULL,
      name       TEXT NOT NULL,
      hidden     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner, name)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON workflow_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_repo ON workflow_runs(owner_name, repo_name);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_conclusion ON workflow_runs(conclusion);
    CREATE INDEX IF NOT EXISTS idx_runs_branch ON workflow_runs(branch);
    CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON workflow_jobs(run_id);

    -- Read-only API tokens for headless clients (#9). Only the SHA-256 hash of
    -- a token is stored; the full value is shown once, at creation.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL,
      prefix       TEXT NOT NULL,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

    -- Cached GitHub answers for the failure resolution endpoint (#11).
    -- ref_kinds: whether a run's head_branch is a tag (GitHub runs do not say).
    CREATE TABLE IF NOT EXISTS ref_kinds (
      owner_name TEXT NOT NULL,
      repo_name  TEXT NOT NULL,
      ref        TEXT NOT NULL,
      is_tag     INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (owner_name, repo_name, ref)
    );
    -- pr_states: open or closed (merged counts as closed) per pull request.
    CREATE TABLE IF NOT EXISTS pr_states (
      owner_name TEXT NOT NULL,
      repo_name  TEXT NOT NULL,
      number     INTEGER NOT NULL,
      state      TEXT NOT NULL,
      merged     INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (owner_name, repo_name, number)
    );
  `);

  // Add pull_request_url column if it doesn't exist (idempotent migration)
  try {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN pull_request_url TEXT');
  } catch (e) {
    // Column already exists — ignore
  }

  // Add actor_type column if it doesn't exist (idempotent migration)
  try {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN actor_type TEXT');
  } catch (e) {
    // Column already exists — ignore
  }

  // Add labels column to workflow_jobs if it doesn't exist (idempotent migration)
  try {
    db.exec('ALTER TABLE workflow_jobs ADD COLUMN labels TEXT');
  } catch (e) {
    // Column already exists — ignore
  }

  // Add head_sha to workflow_runs (#11). Rows synced before this column existed
  // stay NULL until discovery or a webhook re-reads them.
  try {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN head_sha TEXT');
  } catch (e) {
    // Column already exists - ignore
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_repo_sha ON workflow_runs(owner_name, repo_name, head_sha)');

  // Default branch per repo (#5): GitHub's value, an optional override, and when
  // GitHub's value was last fetched (refreshed at most hourly).
  for (const column of ['default_branch TEXT', 'default_branch_override TEXT', 'default_branch_synced_at TEXT']) {
    try {
      db.exec(`ALTER TABLE repos ADD COLUMN ${column}`);
    } catch (e) {
      // Column already exists - ignore
    }
  }

  // Which workflows count toward status (#6): an explicit include/exclude, and
  // the branch for which GitHub was last asked for push evidence.
  for (const column of ['status_mode TEXT', 'push_checked_branch TEXT']) {
    try {
      db.exec(`ALTER TABLE workflows ADD COLUMN ${column}`);
    } catch (e) {
      // Column already exists - ignore
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_workflow_event_branch ON workflow_runs(workflow_id, event, branch)');
}

module.exports = { runMigrations };
