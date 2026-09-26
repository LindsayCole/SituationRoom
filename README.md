# Dead Puck Society — Situation Room v2.2 alpha

A persistent season-long fantasy hockey command center built for **ChatGPT Sites**.

The source of truth is now a Sites-managed D1 database. Browser localStorage is not used as the application database. Manual changes, future Yahoo syncs, schedule refreshes and analysis settings all flow through the same durable state API.

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

Situation Room stores three durable record types.

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
- before/after values where supplied
- metadata
- timestamp
- client change ID for idempotency

The UI exposes this in **History / Storage**.

### Provider sync history

`situation_room_sync_runs`

Reserved for Yahoo and other provider refreshes. It stores provider, status, timestamps, summary and error text so refreshes can be audited separately from individual state changes.

## Save behavior

The browser loads authoritative state from `GET /api/state`.

Every edit queues a `PUT /api/state` containing:

- complete current state snapshot
- expected base revision
- structured change description
- unique client change ID

The server writes the new snapshot and corresponding change record together.

If another session has already advanced the revision, the API returns a conflict instead of silently overwriting newer data.

If a Site save fails, the browser keeps an emergency recovery copy locally. That recovery copy is not considered authoritative application storage.

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

## Yahoo integration model

Yahoo is the next phase.

The persistence layer is already designed for it:

1. Yahoo authentication and credentials live server-side as **ChatGPT Site secrets**.
2. Yahoo fetches run through the Site worker, never from browser JavaScript with a secret.
3. Yahoo response data is merged into the in-memory Situation Room model.
4. The resulting state is written through the same D1 revision API using `source: yahoo`.
5. Sync metadata is written to `situation_room_sync_runs`.
6. Manual projections and protected-player choices can be preserved across Yahoo refreshes instead of being destroyed by a provider sync.

The current Site exposes a safe Yahoo status placeholder until that application/OAuth phase is configured.

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
- `GET /api/yahoo/status` (placeholder until Yahoo phase)

API responses containing user state are marked `Cache-Control: no-store`.

## Build requirements

OpenAI's current Sites tooling requires Node 22.13+ and Vite 8.

```bash
npm install
npm run check
npm test
npm run build
```

The production build packages:

- static Situation Room UI
- worker API
- `.openai/hosting.json`
- D1 migration files under `drizzle/`

## Deployment

This repository is intended to be published through **ChatGPT Sites**, not operated as a standalone Node server.

In ChatGPT Sites, use the repository/project as the source and ask Sites to deploy the current project. Sites will provision the D1 binding declared in `.openai/hosting.json` and apply the packaged database migration.

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

Yahoo application integration:

- configure Yahoo developer application
- configure Site secrets
- OAuth callback in the Sites worker
- encrypted/persistent token handling appropriate for the hosted runtime
- discover team/league
- roster sync
- available-player sync/search
- transaction/week parsing
- sync-run history
- then projection and goalie-start providers
