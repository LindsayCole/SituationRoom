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
