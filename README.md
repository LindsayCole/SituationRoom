# Dead Puck Society — Situation Room v2.3 alpha

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
- other league-team rosters with their source and last update
- projections
- Yahoo roster metadata
- NHL schedule cache
- weekly move count
- week to which the manual move count applies
- planner date
- goalie start probabilities
- Situation Room analysis settings

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

If a Site save fails, pending writes remain in an ordered queue and the browser keeps an emergency recovery copy. On reload, recovery is replayed only when it is safe to do so. If the Site has advanced to a newer revision, the recovered view is preserved for export and the UI requires an explicit reload of authoritative Site state instead of silently overwriting it.

## Existing browser-state migration

On the first visit after deployment:

1. Situation Room checks D1.
2. If no D1 state exists, it looks for old v2/v1 browser state.
3. Existing browser state is written into D1 as an explicit `migrate-browser-state` revision.
4. The old browser state keys are removed after the Site save succeeds.
5. If no old state exists, an **empty roster/waiver seed** becomes revision 1. The application does not invent starter players or teams.

This only helps when the new deployment shares browser origin/storage with the previous Site. JSON backup import remains available for other migrations.

## Manual entry

Manual changes are first-class persistent changes. Current UI actions already write durable revisions for:

- roster player edits
- roster add/remove
- bulk roster import
- individual opponent-team roster imports
- league-wide opponent roster refresh when Yahoo Fantasy API access is active
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

The **League Rosters** screen can load all other teams through Yahoo's league teams and team roster resources. It stores their rosters with update time and source. Manual imports of a selected team remain available while Yahoo access is pending. A player appearing on a tracked roster is marked rostered in Waiver Command. An absent player is still unverified unless Yahoo's available-player query or a user confirmation establishes availability.

Bulk imports of your roster preserve lineup slots. Optional screenshot fantasy points are stored as reference points, separate from current-season Yahoo points and FPPG projections. The weekly acquisition counter displays zero after the local Monday boundary until updated for the new week.

Configure these four hosted runtime values in Sites:

- `YAHOO_CLIENT_ID`: Yahoo Developer application client ID
- `YAHOO_CLIENT_SECRET`: Yahoo Developer application client secret
- `YAHOO_REDIRECT_URI`: the deployed Site's exact `https://.../api/yahoo/callback` URL, also registered in the Yahoo application
- `YAHOO_TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters representing 32 random bytes

The worker requires the callback URL to match the current Site origin. After configuring the Yahoo application and Site secrets, use **Connect Yahoo** and **Sync now**. A sync discovers the user's league team, reads today's roster and available players, merges Yahoo facts with stored manual projections, then saves a revision and sync record. Available-player search uses the same read-only connection. Live Yahoo response shapes still need validation against this league; no credentials are present in this repository.

Yahoo [reviews Fantasy API access separately](https://sports.yahoo.com/developer/access/). A successful OAuth connection does not by itself confirm that Fantasy requests are permitted. If the API responds with 403, the Site keeps manual entry available and records the failed sync attempt.

## NHL schedule

The Site worker proxies the public NHL schedule endpoint through:

```text
GET /api/nhl/schedule?date=YYYY-MM-DD
```

A successful refresh is persisted as an `nhl / schedule-refresh` revision. Seven-day analysis is enabled only when all seven requested dates are confirmed by the NHL response. Missing dates are fetched individually; if coverage is still incomplete, the stored schedule is left unchanged.

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
- `GET /api/yahoo/league-teams`

API responses containing user state are marked `Cache-Control: no-store`. Static Site responses also receive CSP, clickjacking, referrer, MIME-sniffing and permissions-policy protections.

## Data-quality rules

- Unknown values remain unknown. Missing FPPG is stored with `projectionSource: unset`, not treated as a real zero.
- Net waiver/add-drop value is not calculated until the active/bench roster has complete projections.
- Projected-points and leakage KPIs are withheld when roster projections are incomplete.
- A goalie team game is not a goalie start unless a start probability is supplied.
- A selected seven-day period is not considered schedule-ready until all seven dates are confirmed.
- The ChatGPT Situation Brief exports unknown projections/totals as `null`, not `0`.

## Validation

CI checks TypeScript, browser JavaScript syntax, deterministic optimizer/data-quality tests, frontend/HTML selector contracts, persistence contracts, and a full ChatGPT Sites production build. GitGuardian also scans the branch for committed secrets.

Deployed-Site D1 behavior and live Yahoo XML require checks against the private production Site and the owner's Yahoo account.

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

The original `0000_situation_room_persistence` migration is retained for existing databases. `0001_change_revision_uniqueness` guards concurrent history writes, `0002_revision_snapshots` adds immutable state snapshots, and `0003_yahoo_auth_and_history` adds the Yahoo token tables. Existing state rows are preserved during these upgrades.

## Deployment

This repository is intended to be published through **ChatGPT Sites**, not operated as a standalone Node server.

In ChatGPT Sites, use the repository/project as the source and deploy the current project. Sites provisions the D1 binding declared in `.openai/hosting.json`. On its first API request, the worker applies the checked-in, idempotent SQL migrations if required objects are absent, then verifies the schema. This also upgrades an existing v2.2 database without replacing stored state.

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

## Intentionally unfinished

These are planned next-phase items rather than hidden defects:

- Live Yahoo OAuth and league-data smoke test.
- Live Yahoo XML capture and parser fixtures.
- Automatic weekly acquisition counting from Yahoo transactions.
- Automatic projection/FPPG provider.
- Confirmed/probable goalie-start provider.
- Matchup/standings context.
- Official Yahoo Fantasy branding before any public deployment.
- Yahoo write operations only if/when Yahoo explicitly approves the required access.

## Next phase

Validate the first live Yahoo sync for this league, then add transaction-week parsing, forward projections and goalie-start data.
