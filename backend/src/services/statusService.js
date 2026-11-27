const { getDb } = require('../db/database');
const reposService = require('./reposService');
const workflowSelection = require('./workflowSelection');

// Repository status (#7). Semantics only: flags, progress and ETA. No colours.
// Contract: docs/status-api.md. Computed per request from the database.

const SCHEMA_VERSION = 1;
const QUEUED_STATUSES = ['queued', 'waiting', 'pending', 'requested'];
const SKIPPED_CONCLUSIONS = ['cancelled', 'skipped', 'neutral'];
const FAILING_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];
const DURATION_SAMPLES = 20;
const MIN_SAMPLES = 3;
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;
const PROGRESS_CAP = 0.99;

const sqlList = values => values.map(v => `'${v}'`).join(', ');

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile of an ascending array. */
function nearestRank(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Valid durations (ms) of the last successful runs of a workflow on a branch.
 * A run's duration is its latest job completion (or, with no jobs, its
 * updated_at) minus run_started_at. Zero, negative and over-6-hour values are
 * discarded: updated_at can move long after a run finishes.
 */
function successDurations(db, workflowId, branch) {
  const rows = db
    .prepare(
      `SELECT r.run_started_at, r.created_at, r.updated_at,
         (SELECT MAX(j.completed_at) FROM workflow_jobs j WHERE j.run_id = r.id) AS jobs_completed_at
       FROM workflow_runs r
       WHERE r.workflow_id = ? AND r.branch = ? AND r.status = 'completed' AND r.conclusion = 'success'
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 60`
    )
    .all(workflowId, branch);
  const durations = [];
  for (const r of rows) {
    const start = Date.parse(r.run_started_at || r.created_at);
    const end = Date.parse(r.jobs_completed_at || r.updated_at);
    const d = end - start;
    if (Number.isFinite(d) && d > 0 && d <= MAX_DURATION_MS) durations.push(d);
    if (durations.length >= DURATION_SAMPLES) break;
  }
  return durations.sort((a, b) => a - b);
}

function progressFor(latest, durations, now) {
  const none = { progress: null, etaSeconds: null, overrun: false };
  if (latest.status !== 'in_progress' || durations.length < MIN_SAMPLES) return none;
  const started = Date.parse(latest.run_started_at || latest.created_at);
  if (!Number.isFinite(started)) return none;
  const elapsed = Math.max(0, now - started);
  const med = median(durations);
  return {
    progress: Math.min(PROGRESS_CAP, Math.round((elapsed / med) * 1000) / 1000),
    etaSeconds: Math.max(0, Math.round((med - elapsed) / 1000)),
    overrun: elapsed > nearestRank(durations, 90),
  };
}

function workflowStatus(db, workflow, branch, now) {
  const latest = db
    .prepare(
      `SELECT * FROM workflow_runs WHERE workflow_id = ? AND branch = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(workflow.id, branch);
  if (!latest) return null;
  const lastCompleted = db
    .prepare(
      `SELECT conclusion FROM workflow_runs
       WHERE workflow_id = ? AND branch = ? AND status = 'completed'
         AND conclusion IS NOT NULL AND conclusion NOT IN (${sqlList(SKIPPED_CONCLUSIONS)})
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(workflow.id, branch);
  return {
    id: workflow.id,
    name: workflow.name,
    runId: latest.id,
    runNumber: latest.run_number,
    htmlUrl: latest.html_url || null,
    status: latest.status,
    conclusion: latest.conclusion || null,
    startedAt: latest.run_started_at || null,
    building: latest.status === 'in_progress',
    queued: QUEUED_STATUSES.includes(latest.status),
    failing: !!lastCompleted && FAILING_CONCLUSIONS.includes(lastCompleted.conclusion),
    ...progressFor(latest, successDurations(db, workflow.id, branch), now),
  };
}

function repoStatus(db, repo, now) {
  const branch = reposService.effectiveDefaultBranch(repo);
  const base = {
    owner: repo.owner,
    name: repo.name,
    defaultBranch: branch,
    queued: false,
    building: false,
    failing: false,
    unknown: false,
    noCountedWorkflows: false,
    workflows: [],
  };
  if (!branch) return { ...base, unknown: true };

  const counted = workflowSelection.countedWorkflows(repo);
  if (counted.length === 0) return { ...base, noCountedWorkflows: true };

  const workflows = counted.map(w => workflowStatus(db, w, branch, now)).filter(Boolean);
  if (workflows.length === 0) return { ...base, unknown: true };

  return {
    ...base,
    queued: workflows.some(w => w.queued),
    building: workflows.some(w => w.building),
    failing: workflows.some(w => w.failing),
    workflows,
  };
}

/** The full status document. `now` is injectable for tests. */
function computeStatus({ now = Date.now() } = {}) {
  const db = getDb();
  const repos = reposService.getVisibleRepos().map(r => repoStatus(db, r, now));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    overall: {
      queued: repos.some(r => r.queued),
      building: repos.some(r => r.building),
      failing: repos.some(r => r.failing),
      unknown: repos.filter(r => r.unknown).length,
      repoCount: repos.length,
    },
    repos,
  };
}

module.exports = { computeStatus, SCHEMA_VERSION, median, nearestRank };
