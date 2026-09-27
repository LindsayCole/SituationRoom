# Dead Puck Situation Room — v1 Audit and v2 Remediation

Audit date: 2026-09-26

## v1 issues found

### 1. Weekly acquisition limit was visual only
**Severity:** High for season use.

v1 displayed the 5-add weekly limit, but `applyCandidate()` still staged another move after five. The counter simply stopped increasing.

**v2 fix:** waiver staging is disabled when the weekly move count is at 5. The move count is currently manual until Yahoo transaction/week parsing is completed.

### 2. Goalie team games were incorrectly treated as guaranteed goalie starts
**Severity:** High for projections.

v1 used NHL team schedule membership for all players, so a goalie was projected as playing every game his NHL team played.

**v2 fix:** goalies default to 0% start probability until a start chance is explicitly supplied. Team games with an unconfirmed goalie are surfaced separately and are not counted as starts. The optimizer weights goalie expected points by start probability.

### 3. IR and IR+ were not represented in the roster model
**Severity:** Medium/High.

v1 used a flat 18-player capacity and did not preserve Yahoo's selected roster position. A player on IR/IR+ could therefore be incorrectly considered for an active lineup or for active/bench capacity.

**v2 fix:** players now carry `selectedPosition`. IR and IR+ players are excluded from active-lineup optimization and from the 18 active/bench capacity calculation.

### 4. `crypto.randomUUID()` was called directly during seed creation
**Severity:** Low/compatibility.

Browsers without `crypto.randomUUID()` support could fail before the fallback UUID helper was reached.

**v2 fix:** all IDs use a guarded `makeUuid()` helper.

### 5. Waiver analysis could run with no NHL schedule loaded
**Severity:** Medium.

This produced zero-value rankings that looked more meaningful than they were.

**v2 fix:** staging is disabled until NHL schedule data is present. The UI displays an explicit no-data state.

### 6. Local staging was being counted as a real Yahoo acquisition
**Severity:** Medium.

v1 incremented the weekly move counter when a candidate was only applied to the local model.

**v2 fix:** local staging no longer changes the real weekly move count. Weekly move usage is a separate field until Yahoo transaction parsing can calculate it.

### 7. Monolithic browser code was difficult to test
**Severity:** Engineering quality.

The optimizer lived inside the application IIFE and could not be cleanly unit tested.

**v2 fix:** calculation logic moved to `public/logic.js`, an ES module used by both the browser and Node's test runner.

## v2 checks completed

- JavaScript syntax checks pass for server, Yahoo client, token store, browser app and logic module.
- Eight deterministic optimizer/unit tests pass.
- Local HTTP server starts without Yahoo credentials.
- `/api/health` returns successfully.
- `/api/yahoo/status` correctly reports an unconfigured OAuth state.
- Static app responds with security headers and a restrictive CSP.
- Every DOM ID referenced by `app.js` exists in `index.html`.

## v2 items intentionally unfinished

These are not silent TODOs. They are the next development steps.

1. **Live Yahoo OAuth cannot be end-to-end tested until Yahoo credentials/API access are supplied.**
2. **Automatic weekly move counting** needs transaction parsing tied to Yahoo's current scoring week.
3. **Automatic FPPG/projection model** is not yet sourced. Yahoo season fantasy points are synced as context, while FPPG remains editable.
4. **Goalie starter intelligence** is manual for now. A later provider can feed confirmed/probable starts.
5. **Matchup/standings context** is not yet used by the optimizer.
6. **Yahoo write operations are deliberately absent.** Yahoo's current access page says Fantasy API access is read-only by default. A future write layer should be added only after explicit Yahoo approval.
7. **Official Yahoo Fantasy logo/branding** must be added before a public deployment that displays Yahoo API data.
8. **Production hosting/authentication** is not configured. The v2 server binds to `127.0.0.1` by default because it holds OAuth tokens.

## Recommendation for the next implementation pass

After Yahoo credentials are configured, the next pass should validate the live XML payloads, finish transaction/week parsing, then add a projection provider. That order avoids building calculations around imagined API shapes.


# v2.1 code review — Yahoo auth, sync and player presentation

Review date: 2026-09-26

## Additional defects found and remediated

### 8. Missing Yahoo numeric values were silently converted to zero
**Severity:** High for data quality.

JavaScript converts `null` to numeric zero. The v2 normalization path therefore turned an absent Yahoo season-points value into `0`, making "not returned" indistinguishable from a real zero.

**v2.1 fix:** nullable Yahoo numeric fields now preserve `null` explicitly.

### 9. Yahoo roster sync did not request player stats
**Severity:** High for presentation/analytics.

The roster endpoint requested player metadata only, so `Yahoo pts` on roster players could never populate even though the UI exposed the field.

**v2.1 fix:** roster reads now request player `stats` and `percent_owned` sub-resources in league context.

### 10. Yahoo roster sync used the planner's selected date
**Severity:** Medium/High.

Changing the 7-day planner to a future date before syncing could cause the room to display that date's Yahoo roster/slot assignment as if it were the current roster.

**v2.1 fix:** normal Yahoo sync always reads today's roster and records the roster date separately. Planner date remains independent.

### 11. Yahoo rostered percentage was parsed and then discarded
**Severity:** Medium.

`percent_owned` was extracted from Yahoo XML but not retained by the normalization layer.

**v2.1 fix:** the player model preserves rostered percentage, image URL, waiver date, ownership type and projection provenance.

### 12. Players without a projection could appear actionable
**Severity:** High for recommendations.

Yahoo-synced players arrive with identity/stats, not a trustworthy forward FPPG projection. Treating the default `0` as a real projection could create meaningless add/drop rankings.

**v2.1 fix:** Yahoo players now have an explicit `projectionSource=unset`. Add/drop staging is disabled until a projection is supplied. Schedule information remains visible.

### 13. Injured goalies were mislabeled as "start unconfirmed"
**Severity:** Medium.

A goalie on IR/IR+/NA/O whose NHL team played could be surfaced as a healthy goalie whose starter status was unknown.

**v2.1 fix:** unavailable players are separated from healthy-but-unconfirmed goalies and excluded from scheduled usable-game counts.

### 14. Yahoo API responses could be cached by the browser/intermediary
**Severity:** Medium/security hygiene.

Private Yahoo XML/JSON responses did not explicitly set a no-store cache policy.

**v2.1 fix:** Yahoo/API JSON and XML responses now emit `Cache-Control: no-store`.

### 15. Encrypted token location depended on Node's launch directory
**Severity:** Medium/operational.

The encrypted token file used `path.resolve('.data/...')`, which resolves against process working directory.

**v2.1 fix:** token storage is anchored to the application directory regardless of where Node is launched.

### 16. No automated CI existed
**Severity:** Engineering quality.

Syntax and unit tests had been run manually but GitHub did not enforce them on changes.

**v2.1 fix:** GitHub Actions now runs Node 20 syntax checks and the unit suite on pushes and pull requests.

## Yahoo player workflow added in v2.1

1. OAuth remains server-side.
2. Situation Room discovers the signed-in user's active NHL fantasy team.
3. Normal sync reads today's Yahoo roster with roster slot, injury/status, cant-cut flag, season fantasy points and rostered percentage where Yahoo supplies them.
4. The top 100 available players are loaded by Yahoo season fantasy points.
5. Additional available players can be searched on demand by name and optional position instead of enumerating the complete league player pool.
6. Yahoo identity fields are treated as authoritative in the UI.
7. Situation Room projection fields remain separate and editable.
8. A waiver candidate cannot be staged locally until a projection has been supplied.

## Still intentionally incomplete

- Live OAuth/token exchange must be validated with the user's approved Yahoo application.
- Yahoo response shapes should be captured from that live test and retained as fixtures for parser regression tests.
- Weekly acquisition usage is still manual.
- Forward-looking player FPPG is still a separate projection problem; Yahoo season points are context, not automatically treated as a forecast.
- Goalie starter probability still needs a provider.
- No Yahoo write operations are implemented.


# v2.2 architecture review — ChatGPT Sites persistence

Review date: 2026-09-26

## Architecture change

The standalone Node/local-server design is retired as the deployment target. ChatGPT Sites is now the target runtime.

Durable application state uses the Sites-managed D1 binding `DB`.

## Persistence guarantees implemented

- D1 is authoritative; localStorage is not the database.
- One current state snapshot is stored per authenticated ChatGPT Site user.
- Every write increments an optimistic-concurrency revision.
- Every revision writes a separate append-only change event.
- Client change IDs make retry handling safer.
- A stale browser revision receives HTTP 409 instead of overwriting newer data.
- Failed browser saves keep an emergency recovery copy locally.
- Old browser state can be migrated into D1 on first use.
- Sync-run storage is reserved for Yahoo/provider refresh auditing.
- API state responses use `Cache-Control: no-store`.

## Manual actions now persisted

Roster edits, add/remove, imports, waiver changes, projection edits, locally staged moves, weekly move-count edits, planner date, NHL schedule refreshes, backup import and resets all write durable revisions.

## Yahoo readiness

Yahoo application authorization was deferred in the initial v2.2 merge. The follow-up review implementation adds Site-side OAuth, encrypted per-user token storage, read-only Fantasy endpoints, and sync-run history. A live Yahoo sync still requires the owner's Site secrets and Yahoo application configuration.

Yahoo secrets/tokens must not be stored in browser state or committed to Git. They will be handled by the Site worker and owner-managed Site secrets.
