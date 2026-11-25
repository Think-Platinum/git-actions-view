# Failure resolution API: `POST /api/v1/state/resolve`

Handwritten contract for headless clients that filter GitHub Actions failure
notifications, such as Auden's daily digest. This is not a generated spec.
Tracked in Think-Platinum/git-actions-view#11.

A client sends the failures it has seen (parsed from GitHub's notification
emails) and GAV says, for each one, whether it is still outstanding. GAV answers
from its own database. It only reports a failure as resolved when it has
evidence: a completed successful run, or a closed pull request read from GitHub.

**Clients must treat `unknown`, any error and any timeout as "still
outstanding".** GAV never guesses that a failure is resolved.

## Authentication

Either of:

- a browser session (as for every other route), or
- a read-only API token: `Authorization: Bearer gav_...`.

Tokens are sent in the header only, never in the query string. With
authentication disabled on the server, the route is open, like every other
route. Missing or invalid credentials get `401`.

To mint a token, see "Creating a token" below.

## Request

```
POST /api/v1/state/resolve
Authorization: Bearer gav_...
Content-Type: application/json
```

```json
{
  "failures": [
    { "repo": "Think-Platinum/cohorta-mobile", "workflow": "Deploy Dev", "ref": "main",
      "sha": "ef22f09", "kind": "push", "attempt": 2 },
    { "repo": "Think-Platinum/cohorta", "workflow": "CI",
      "ref": "fix: declare the 13 Firestore expiry policies with the API (#1559)",
      "sha": "0a1e314", "kind": "pr", "attempt": 1 }
  ]
}
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name`. Matched case-insensitively against GAV's watched, visible repos. |
| `workflow` | Workflow name, matched exactly. It may contain `: `, for example `CI: Weekly`. |
| `ref` | For `push`: the branch or tag name, for example `main`, `v1.12.2` or `registry-test/157`. For `pr`: the PR title. It is ignored, because titles are unreliable. |
| `sha` | Short (7 characters) or full head commit sha. Matched as a prefix of the run's `head_sha`. |
| `kind` | `push` ("Run failed" emails, which also covers schedule and manual runs) or `pr` ("PR run failed" emails). |
| `attempt` | The attempt number from the email. Optional, and defaults to 1. |

Limits:

- A body that is not `{ "failures": [ ... ] }`, or that has more than 50
  entries, gets `400`.
- An individual entry that is malformed does not fail the batch. It answers
  `unknown`.

## Response

`200`, with `Cache-Control: no-store`. `results` has exactly one entry per
input, in input order.

<!-- response-example -->
```json
{
  "results": [
    {
      "outstanding": false,
      "reason": "retried_ok",
      "latestRun": {
        "id": 123,
        "conclusion": "success",
        "headSha": "ef22f09c4d2b8a1e5f3a9b7c6d5e4f3a2b1c0d9e",
        "completedAt": "2026-11-25T05:20:00Z",
        "url": "https://github.com/Think-Platinum/cohorta-mobile/actions/runs/123"
      }
    },
    {
      "outstanding": true,
      "reason": "unknown"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `outstanding` | `true` only for `still_failing` and `unknown`. |
| `reason` | One of `still_failing`, `superseded`, `retried_ok`, `pr_closed`, `unknown`. |
| `latestRun` | Optional, and omitted for `unknown`. It is the run that decided the answer (see below). `url` is the run's GitHub page. `completedAt` is `null` while that run is still in progress. |

What `latestRun` is, for each reason:

| `reason` | `latestRun` |
|---|---|
| `retried_ok` | The failed run, whose later attempt succeeded. |
| `superseded` | The newer successful run. |
| `pr_closed` | The failed run. |
| `still_failing` | The latest later completed run if one exists, otherwise the failed run. |

## How GAV decides

1. **Find the failed run.**
   - The run must be in the same repo, with the exact workflow name and a
     `head_sha` that starts with `sha`.
   - For `push`, the run's branch must equal `ref`, and its event must not be
     `pull_request` or `pull_request_target`.
   - For `pr`, its event must be one of those two.
   - If nothing matches, the answer is `unknown`. That covers a repo that is
     not watched, a hidden repo, a run not yet synced, and a run synced before
     GAV stored shas.
2. **Re-run passed:** if the run has a later attempt than the email's and it is
   now `success`, the answer is `retried_ok`.
3. **Later run on the same branch:**
   - GAV takes the most recent completed run of the same workflow, on the same
     branch and in the same event family, created after the failed run.
   - Runs that ended `cancelled`, `skipped` or `neutral` are ignored.
   - If that run succeeded, the answer is `superseded`. Otherwise, or if there
     is no such run, it is `still_failing`.
4. **Tags:** if `ref` is a tag (GAV asks GitHub, and caches the answer), a later
   successful run of the same workflow on any other tag also gives
   `superseded`. "Later" means created after the failed run, not a higher
   version number.
5. **Pull requests:**
   - The PR is identified from the failed run itself, not from the title.
   - If GitHub says the PR is closed or merged, the answer is `pr_closed`.
     Otherwise rule 3 is applied to the PR's head branch.
   - If the PR lookup fails, or GAV is pausing GitHub calls for the rate limit,
     no `pr_closed` answer is given.

The common case answers from GAV's database. Only rules 4 and 5 can call
GitHub. Those calls are cached and time out after 3 seconds, so a batch of
about 20 failures answers well inside a 10 second client timeout.

Compatibility: fields may be added to responses. Clients should ignore fields
they do not know.

## Creating a token

Tokens are read-only and are shown once. On the GAV host:

```
docker compose exec gitactionsview node src/cli/create-api-token.js auden
```

Or, while signed in to GAV, from the browser console on the GAV page:

```js
fetch('/api/v1/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'auden' }) }).then(r => r.json()).then(console.log)
```

List tokens with `GET /api/v1/tokens`. Revoke one with
`DELETE /api/v1/tokens/<id>`. Both need a signed-in session.
