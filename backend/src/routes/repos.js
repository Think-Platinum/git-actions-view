const express = require('express');
const fs = require('fs');
const path = require('path');
const { ensureAuthenticated, sessionRateLimit } = require('../auth/middleware');
const { getDb } = require('../db/database');
const reposService = require('../services/reposService');
const workflowSelection = require('../services/workflowSelection');
const syncDispatcher = require('../services/syncDispatcher');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/v1/repos — list all repos (including hidden).
 */
router.get('/api/v1/repos', ensureAuthenticated, (req, res) => {
  const repos = reposService.getAllRepos().map(reposService.toApi);
  res.json({ repos });
});

/**
 * POST /api/v1/repos — add a new repo and trigger immediate sync.
 */
router.post('/api/v1/repos', ensureAuthenticated, async (req, res) => {
  const { owner, name } = req.body;
  if (!owner || !name) {
    return res.status(400).json({ error: 'owner and name are required' });
  }

  const repo = reposService.addRepo(owner.trim(), name.trim());
  if (!repo) {
    return res.status(500).json({ error: 'Failed to add repository' });
  }

  // Trigger immediate sync for the new repo
  syncDispatcher.syncSingleRepo(repo.owner, repo.name);

  res.status(201).json({ repo: reposService.toApi(repo) });
});

/**
 * PUT /api/v1/repos/:id — update a repo: `hidden` and/or
 * `defaultBranchOverride` (#5; a string sets it, null or '' clears it).
 */
router.put('/api/v1/repos/:id', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const hasHidden = body.hidden !== undefined;
  const hasOverride = Object.prototype.hasOwnProperty.call(body, 'defaultBranchOverride');

  if (!hasHidden && !hasOverride) {
    return res.status(400).json({ error: 'hidden or defaultBranchOverride is required' });
  }

  let override;
  if (hasOverride) {
    override = reposService.normaliseBranchOverride(body.defaultBranchOverride);
    if (override.error) {
      return res.status(400).json({ error: override.error });
    }
  }

  let repo = reposService.getAllRepos().find(r => r.id === id);
  if (!repo) {
    return res.status(404).json({ error: 'Repository not found' });
  }
  if (hasHidden) repo = reposService.updateRepo(id, { hidden: body.hidden });
  if (hasOverride) repo = reposService.setDefaultBranchOverride(id, override.value);

  res.json({ repo: reposService.toApi(repo) });
});

/**
 * GET /api/v1/repos/:id/workflows — the repo's workflows, whether each counts
 * toward status, and why (#6).
 */
router.get('/api/v1/repos/:id/workflows', sessionRateLimit, ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const repo = reposService.getAllRepos().find(r => r.id === id);
  if (!repo) {
    return res.status(404).json({ error: 'Repository not found' });
  }
  res.json({ effectiveDefaultBranch: reposService.effectiveDefaultBranch(repo), workflows: workflowSelection.listRepoWorkflows(repo) });
});

/**
 * PUT /api/v1/repos/:id/workflows/:workflowId — set `statusMode` to
 * 'include' or 'exclude', or null to return to the default rule (#6).
 */
router.put('/api/v1/repos/:id/workflows/:workflowId', sessionRateLimit, ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!/^\d+$/.test(req.params.workflowId)) {
    return res.status(400).json({ error: 'Invalid workflow id' });
  }
  const body = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(body, 'statusMode')) {
    return res.status(400).json({ error: 'statusMode is required' });
  }
  const mode = body.statusMode;
  if (mode !== null && !workflowSelection.STATUS_MODES.includes(mode)) {
    return res.status(400).json({ error: 'statusMode must be "include", "exclude" or null' });
  }
  const repo = reposService.getAllRepos().find(r => r.id === id);
  if (!repo) {
    return res.status(404).json({ error: 'Repository not found' });
  }
  const workflow = workflowSelection.setStatusMode(repo, Number(req.params.workflowId), mode);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found for this repository' });
  }
  res.json({ workflow });
});

/**
 * DELETE /api/v1/repos/:id — remove repo and all its data.
 */
router.delete('/api/v1/repos/:id', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = reposService.deleteRepo(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Repository not found' });
  }
  res.json({ success: true });
});

/**
 * GET /api/v1/repos/:id/stats — per-repo metrics.
 */
router.get('/api/v1/repos/:id/stats', ensureAuthenticated, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const repo = reposService.getAllRepos().find(r => r.id === id);
  if (!repo) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const { owner, name } = repo;

  try {
    const runCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM workflow_runs WHERE owner_name = ? AND repo_name = ?'
    ).get(owner, name).cnt;

    const workflowCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM workflows WHERE owner_name = ? AND repo_name = ?'
    ).get(owner, name).cnt;

    const jobCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM workflow_jobs
       WHERE run_id IN (SELECT id FROM workflow_runs WHERE owner_name = ? AND repo_name = ?)`
    ).get(owner, name).cnt;

    const latestRun = db.prepare(
      'SELECT created_at FROM workflow_runs WHERE owner_name = ? AND repo_name = ? ORDER BY created_at DESC LIMIT 1'
    ).get(owner, name);

    // Estimate data size based on proportion of runs
    const totalRuns = db.prepare('SELECT COUNT(*) as cnt FROM workflow_runs').get().cnt;
    let estimatedSizeBytes = 0;
    try {
      const stat = fs.statSync(path.resolve(config.dbPath));
      estimatedSizeBytes = totalRuns > 0 ? Math.round((runCount / totalRuns) * stat.size) : 0;
    } catch {
      // ignore
    }

    res.json({
      runCount,
      workflowCount,
      jobCount,
      latestRun: latestRun?.created_at || null,
      estimatedSizeBytes,
    });
  } catch (err) {
    console.error('Repo stats error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve repo stats' });
  }
});

module.exports = router;
