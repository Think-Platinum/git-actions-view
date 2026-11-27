# Repository status API: `GET /api/v1/status`

Handwritten contract for clients that show build status, such as a status dashboard, desk lights or a headless agent. This is not a generated spec. Tracked in Think-Platinum/git-actions-view#7.

One call says, for every watched repository, whether anything is **queued**, **building** or **failing** on its default branch, with progress for running builds. GAV reports semantics only. **There are no colours or presentation fields**: each client decides how to show the flags.

## Authentication

Either of:

- a browser session, or
- a read-only API token: `Authorization: Bearer gav_...` (see the README, "API tokens").

Missing or invalid credentials get `401`. With authentication disabled on the server, the route is open, like every other route. Responses carry `Cache-Control: no-store`.

## Response

<!-- response-example -->
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-27T09:00:00.000Z",
  "overall": { "queued": false, "building": true, "failing": true, "unknown": 0, "repoCount": 20 },
  "repos": [
    {
      "owner": "Think-Platinum",
      "name": "cohorta",
      "defaultBranch": "main",
      "queued": false,
      "building": true,
      "failing": true,
      "unknown": false,
      "noCountedWorkflows": false,
      "workflows": [
        {
          "id": 101,
          "name": "CI",
          "runId": 9001,
          "runNumber": 412,
          "htmlUrl": "https://github.com/Think-Platinum/cohorta/actions/runs/9001",
          "status": "in_progress",
          "conclusion": null,
          "startedAt": "2026-11-27T08:58:30Z",
          "building": true,
          "queued": false,
          "failing": true,
          "progress": 0.42,
          "etaSeconds": 95,
          "overrun": false
        }
      ]
    }
  ]
}
```

### `overall`

| Field | Meaning |
|---|---|
| `queued`, `building`, `failing` | True when any repo has that flag. |
| `unknown` | Number of repos whose status cannot be determined (see below). |
| `repoCount` | Number of visible repos. Hidden repos are excluded everywhere. |

### `repos[]`

| Field | Meaning |
|---|---|
| `defaultBranch` | The branch status is computed on: GAV's override, else GitHub's default branch. `null` when not known. |
| `queued`, `building`, `failing` | True when any counted workflow has that flag. |
| `unknown` | `true`, with every flag `false`, when the default branch is not known, or when workflows count but none has a run on the branch. Counted in `overall.unknown`. |
| `noCountedWorkflows` | `true` when the branch is known but no workflow counts toward status, for example when every workflow is manual. Every flag is `false` and the repo is **not** unknown. Display it if you like, but it is not a problem state. |
| `workflows` | The counted workflows that have a run on the branch. |

### `repos[].workflows[]`

| Field | Meaning |
|---|---|
| `runId`, `runNumber`, `htmlUrl`, `status`, `conclusion`, `startedAt` | The workflow's **latest** run on the branch. |
| `queued` | That latest run is `queued`, `waiting`, `pending` or `requested`. |
| `building` | That latest run is `in_progress`. |
| `failing` | The most recent **completed** run ended in `failure`, `timed_out` or `startup_failure`. Runs that ended `cancelled`, `skipped` or `neutral` are passed over, and the one before is used. `action_required` is not failing. |
| `progress` | 0 to 0.99, only while building. It is the elapsed time divided by the median of recent successful run durations, and is `null` with fewer than 3 samples. |
| `etaSeconds` | The median duration minus the elapsed time, never below 0. `null` when `progress` is `null`. |
| `overrun` | `true` once the build has run longer than the 90th percentile of recent durations (nearest rank). Treat the end time as unknown. Always `false` when not building or with fewer than 3 samples. |

The flags are independent. A workflow rebuilding after a failure is both `building` and `failing`.

## Which workflows count

By default, a workflow counts when it is active, is not GitHub-managed (`dynamic/...`, for example Copilot, Dependabot or CodeQL), and has run on push to the default branch. Manual and scheduled workflows count only when included by hand. Disabled workflows never count. Both the branch and each workflow's include or exclude setting can be changed on GAV's Settings page.

## How durations are measured

A successful run's duration is from `run_started_at` to its last job's completion (or the run's `updated_at` when it has no jobs). Up to the last 20 durations are used. Values over 6 hours, zero or negative are ignored, because GitHub can move `updated_at` long after a run finishes.

## Versioning and compatibility

- `schemaVersion` is `1`.
- Fields may be **added** without a version change. **Clients must ignore fields they do not know.**
- A rename, removal, type change or change of meaning bumps `schemaVersion`. A client that sees an unexpected version should keep its last good state and log a warning, rather than guess.
- `generatedAt` is the time of the request, not a measure of how fresh the data is.

## Polling and events

Status is computed per request from GAV's database, which takes milliseconds. Poll every 30 seconds or so. For faster updates, listen on `GET /api/v1/events` (server-sent events; tokens are accepted, at most 5 streams per token). Refetch on `sync:complete`, debounced to at most once every 2 seconds, because a sync fires that event once per repo.
