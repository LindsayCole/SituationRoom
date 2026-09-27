# Dead Puck Society — Situation Room v2.2 alpha

A persistent season-long fantasy hockey command center built for **ChatGPT Sites**.

The source of truth is a Sites-managed D1 database. Browser localStorage holds only unsaved recovery copies and one-time migration data. Manual changes, Yahoo syncs, schedule refreshes and analysis settings flow through the durable state API.

## Runtime

- ChatGPT Sites
- Vite 8
- Hono worker API
- Sites-managed Cloudflare D1 binding: `DB`
- Sign in with ChatGPT identity supplied by the Sites runtime
- No OpenAI API billing

The Sites project manifest is:

```json
{
  "d1": "DB",
  "r2": null
}
```

When ChatGPT Sites provisions the project it adds the hosted project linkage to `.openai/hosting.json`.

## Persistent data model

Situation Room stores current state, change history, sync history, encrypted Yahoo tokens and short-lived OAuth state records.

### Current state

`situation_room_state`

One current application snapshot per signed-in Site user:

- roster
- waiver/player pool
- projections
- Yahoo roster metadata
- NHL schedule cache
- weekly move count
- planner date
- goalie start probabilities
- local analysis settings

Every successful write increments a numeric revision.

### Change history

`situation_room_changes`

Append-only audit records for every stored revision, including:

- revision
- source: manual, Yahoo, NHL, or system
- action
- entity type and identifier where applicable
- server-computed before/after values for every changed top-level state field
- metadata
- timestamp
- client change ID for idempotency

The UI exposes this in **History / Storage**.

### Provider sync history

`situation_room_sync_runs`

Yahoo success and failure records contain status, timestamps, summary or error text. The UI displays these alongside change history.

## Save behavior

The browser loads authoritative state from `GET /api/state`.

Every edit queues a `PUT /api/state` containing:

- complete current state snapshot
- expected base revision
- structured change description
- unique client change ID

The server validates the state and writes the new snapshot and corresponding change record in one D1 transaction. A conditional history insert prevents a losing concurrent save from leaving a false event. Client change IDs let a repeated request recognize a committed save.

If another session has already advanced the revision, the API returns a conflict instead of silently overwriting newer data.

If a save fails, the browser keeps an emergency recovery copy locally. On reload, it retries when the Site revision is unchanged; otherwise, the History / Storage area offers a download or a deliberate restore over newer Site data. Recovery copies are not authoritative application storage.

## Existing browser-state migration

On the first visit after deployment:

1. Situation Room checks D1.
2. If no D1 state exists, it looks for old v2/v1 browser state.
3. Existing browser state is written into D1 as an explicit `migrate-browser-state` revision.
4. The old browser state keys are removed after the Site save succeeds.
5. If no old state exists, the standard seed becomes revision 1.

This only helps when the new deployment shares browser origin/storage with the previous Site. JSON backup import remains available for other migrations.

## Manual entry

Manual changes are first-class persistent changes. Current UI actions already write durable revisions for:

- roster player edits
- roster add/remove
- bulk roster import
- waiver candidate import/clear
- waiver projection edits
- locally staged add/drop analysis
- weekly moves used
- planner date
- NHL schedule refresh
- JSON backup import
- reset

## Yahoo connection

The Site worker handles Yahoo's authorization code flow and read-only Fantasy API requests. It encrypts each user's access and refresh tokens with AES-GCM before storing them in D1. The client secret and encryption key stay in Site secrets. The browser receives neither the client secret nor the refresh token.

Configure these four hosted runtime values in Sites:

- `YAHOO_CLIENT_ID`: Yahoo Developer application client ID
- `YAHOO_CLIENT_SECRET`: Yahoo Developer application client secret
- `YAHOO_REDIRECT_URI`: the deployed Site's exact `https://.../api/yahoo/callback` URL, also registered in the Yahoo application
- `YAHOO_TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters representing 32 random bytes

The worker requires the callback URL to match the current Site origin. After configuring the Yahoo application and Site secrets, use **Connect Yahoo** and **Sync now**. A sync discovers Dead Puck Society's league team, reads today's roster and the top 100 available players, merges Yahoo facts with stored manual projections, then saves one revision and a sync record. Available-player search uses the same read-only connection. The first live Yahoo response still needs validation against the league's actual data; no live Yahoo credentials are present in this repository.

Yahoo writes, transaction-week parsing, forward projections and goalie-start providers are not implemented.

## NHL schedule

The Site worker proxies the public NHL schedule endpoint through:

```text
GET /api/nhl/schedule?date=YYYY-MM-DD
```

A successful refresh is persisted as an `nhl / schedule-refresh` revision.

## Persistent API

- `GET /api/health`
- `GET /api/session`
- `GET /api/state`
- `PUT /api/state`
- `GET /api/changes?limit=100`
- `GET /api/sync-runs`
- `GET /api/nhl/schedule?date=YYYY-MM-DD`
- `GET /api/yahoo/status`, `/api/yahoo/login`, `/api/yahoo/callback`
- `POST /api/yahoo/disconnect`, `/api/yahoo/sync-failure`
- `GET /api/yahoo/teams`, `/api/yahoo/roster`, `/api/yahoo/available`, `/api/yahoo/transactions`, `/api/yahoo/league`

API responses containing user state are marked `Cache-Control: no-store`.

## Build requirements

OpenAI's current Sites tooling requires Node 22.13+ and Vite 8.

```bash
npm ci
npm run check
npm test
npm run build
```

The production build packages:

- static Situation Room UI
- worker API
- `.openai/hosting.json`
- generated D1 migration SQL and metadata under `drizzle/`, also copied into the Worker build output

## Deployment

This repository is intended to be published through **ChatGPT Sites**, not operated as a standalone Node server.

In ChatGPT Sites, use the repository/project as the source and deploy the current project. Sites provisions the D1 binding declared in `.openai/hosting.json` and applies the packaged database migration. The worker checks for the schema at runtime and reports an error if deployment omitted it.

The initial deployed Site should remain private to the intended user/workspace while Yahoo credentials and live league data are being validated.

## Data residency note

ChatGPT Sites is currently a public-beta feature. OpenAI documents that deployed Site code, D1/R2 data, files and related logs are not covered by ChatGPT data-residency or inference-residency guarantees at launch. Review this before storing information that has residency requirements.

## Current league

- Yahoo League ID: `46311`
- League: **Blades of Glory Tokyo Drift**
- Team: **Dead Puck Society**
- 12 teams
- Head-to-Head Points
- 5 acquisitions per week
- Continual rolling waiver list
- Daily - Today lineup changes
- 2-day waiver time

## Next phase

Validate the first live Yahoo sync for this league, then add transaction-week parsing, forward projections and goalie-start data.
