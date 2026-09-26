# Dead Puck Society — Situation Room v2.1 alpha

A season-long command center for the 2026–27 Yahoo fantasy hockey league **Blades of Glory Tokyo Drift**.

v2.1 keeps the deterministic lineup/waiver engine, hardens the Yahoo OAuth/read-sync layer, and separates Yahoo's authoritative player/roster data from Situation Room's editable projection model. It does **not** use the OpenAI API.

## What v2 does now

- Daily lineup optimization with multi-position eligibility.
- 7-day NHL schedule planner.
- Light-night / heavy-night analysis.
- Bench-congestion and expected-point leakage calculations.
- IR/IR+ awareness.
- Conservative goalie handling: a team game is not automatically a goalie start.
- Waiver candidate ranking by net usable 7-day value.
- Manual FPPG editing.
- Yahoo OAuth 2.0 backend scaffold.
- Yahoo roster sync using today's authoritative roster date.
- Yahoo available-player sync, including season fantasy points and rostered percentage when Yahoo supplies them.
- On-demand Yahoo available-player search by name and position.
- Clear projection provenance: Yahoo identity/stats are separate from editable FPPG.
- Players with no projection are visible but are not treated as actionable add/drop recommendations.
- Encrypted Yahoo token storage on the server, anchored to the app directory.
- GitHub Actions CI for syntax checks and unit tests.
- ChatGPT Situation Brief export without paid OpenAI API usage.
- JSON backup/restore.
- Unit-tested optimizer logic.

## Important Yahoo access note

Yahoo's current Fantasy API application page states that access is **read-only by default**. The documentation still describes write-capable roster/transaction resources, but this application intentionally exposes no write endpoints until Yahoo has explicitly approved read/write access.

## Requirements

- Node.js 20 or newer.
- Yahoo Fantasy Sports API access and OAuth credentials for live Yahoo sync.

No npm dependencies are required.

## First run without Yahoo

```bash
cd SituationRoom
npm test
npm start
```

Open:

```text
http://127.0.0.1:8787
```

The app works in local/manual mode even when Yahoo is not configured.

## Configure Yahoo OAuth

1. Apply for / confirm Yahoo Fantasy Sports API access.
2. Create or use a Yahoo Developer application with Fantasy Sports permission.
3. Configure this callback URL in Yahoo for local testing:

```text
http://127.0.0.1:8787/api/yahoo/callback
```

4. Copy the environment template:

```bash
cp .env.example .env
```

5. Fill in:

```text
YAHOO_CLIENT_ID=
YAHOO_CLIENT_SECRET=
YAHOO_TOKEN_ENCRYPTION_KEY=
```

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

6. Start the server and open **Yahoo Sync**. The page shows any missing environment variables and the configured callback URI.
7. Select **Connect Yahoo** to complete Yahoo's Authorization Code consent flow.
8. After authorization, select **Sync now**. Situation Room discovers your NHL fantasy team, syncs today's roster, then loads the top 100 available players by Yahoo season fantasy points.

Do not commit your real `.env` file or paste the Yahoo client secret into chat.

## Yahoo player workflow

Yahoo and Situation Room deliberately have different jobs:

1. **Yahoo is authoritative for identity and league state:** player key, name, NHL team, eligible positions, Yahoo roster slot, injury/status, cant-cut state, ownership type, season fantasy points and rostered percentage when available.
2. **Situation Room owns projections:** FPPG, core/drop protection and goalie start probability remain editable analysis inputs.
3. A normal sync reads **today's Yahoo roster**, regardless of the date currently selected in the 7-day planner.
4. The initial player pool contains the top 100 available players sorted by Yahoo season fantasy points.
5. Use the Yahoo player search in **Waiver Command** to pull additional available players by name and optional position without repeatedly enumerating the whole player universe.
6. A Yahoo-synced player with no projection is displayed as **Projection needed** and cannot be staged as an add/drop until an FPPG value is supplied.

## Yahoo data flow

The browser never receives the Yahoo consumer secret or refresh token.

```text
Browser
  |
  | same-origin API calls
  v
Dead Puck Node server
  |
  | OAuth access token
  v
Yahoo Fantasy Sports API
```

The refresh/access token is encrypted at rest in:

```text
.data/yahoo-token.enc
```

The encryption key remains in `.env` and is not committed.

## Current Yahoo read endpoints

The server exposes narrow, validated endpoints only:

- `GET /api/yahoo/status`
- `GET /api/yahoo/login`
- `GET /api/yahoo/callback`
- `POST /api/yahoo/disconnect`
- `GET /api/yahoo/teams`
- `GET /api/yahoo/roster?teamKey=...&date=YYYY-MM-DD`
- `GET /api/yahoo/available?leagueKey=...&status=A&start=0&count=50`
- `GET /api/yahoo/transactions?leagueKey=...&teamKey=...`
- `GET /api/yahoo/league?leagueKey=...`

There is deliberately no generic Yahoo proxy and no write endpoint.

## League configuration captured from Yahoo

- League ID: `46311`
- League: `Blades of Glory Tokyo Drift`
- Teams: `12`
- Scoring: Head-to-Head Points
- Maximum acquisitions per week: `5`
- Waiver time: `2 days`
- Waiver type: Continual rolling list
- Daily lineup changes: Daily - Today
- No minimum goalie appearances
- Dead Puck Society waiver priority screenshot: `#6`

### Active / bench roster

`C, C, LW, LW, RW, RW, D, D, D, D, Util, Util, G, G, BN, BN, BN, BN`

Reserve: `IR, IR, IR+, IR+`

### Skater scoring

| Stat | Points |
|---|---:|
| Goal | 3 |
| Assist | 2 |
| PIM | 0.3 |
| PPP | 1 |
| SHP | 1 |
| GWG | 1 |
| SOG | 0.3 |
| HIT | 0.3 |
| BLK | 0.3 |

### Goalie scoring

| Stat | Points |
|---|---:|
| Win | 4 |
| Goal Against | -1 |
| Save | 0.2 |
| Shutout | 3 |

## Goalie handling

A goalie being on an NHL team that plays tonight does not mean that goalie starts tonight.

v2 therefore gives goalies a `startProbability` value. The default is 0 until manually set or later populated by a goalie-start provider. A value of 75 means the engine uses 75% of the goalie's FPPG as expected value for that team game.

This is intentionally conservative and fixes a large projection error in v1.

## FPPG and Yahoo season points

Yahoo sync can import Yahoo season fantasy points and rostered percentage. Those values are useful context, but they are **not** automatically treated as a forward-looking FPPG forecast.

FPPG remains a separate editable Situation Room projection. When a Yahoo player has no projection, the UI says so explicitly and add/drop staging remains disabled for that player.

## ChatGPT without OpenAI API billing

Use **ChatGPT Bridge → Copy Situation Brief**. The packet contains:

- current roster and Yahoo roster slots,
- injuries/status,
- goalie uncertainty,
- NHL schedule,
- optimized starts,
- blocked players,
- waiver candidates,
- Yahoo season points,
- net modeled add/drop value.

Paste that packet into the existing ChatGPT conversation for deeper analysis.

## Tests

```bash
npm run check
npm test
```

The current suite covers multi-position assignment, negative-value benching, IR/unavailable-player exclusion, goalie start uncertainty, candidate/open-slot logic, imports, and seven-day projections. GitHub Actions runs both syntax checks and the unit suite on pushes and pull requests.

See `CODE_AUDIT.md` for the v1 findings and the remaining v2 work.
