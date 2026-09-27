import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

test('every literal app element reference exists in the page', async () => {
  const html = await readFile('index.html', 'utf8');
  const app = await readFile('public/app.js', 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const used = [...app.matchAll(/\$\('#([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(used.filter((id) => !ids.has(id)))], []);
});

test('Site saves reject invalid state, recognize retries, and keep concurrent history exact', async () => {
  const mf = new Miniflare({
    scriptPath: 'dist/dead_puck_situation_room/index.js',
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-05-22',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  try {
    const db = await mf.getD1Database('DB');
    const baseline = await readFile('dist/dead_puck_situation_room/drizzle/0000_situation_room_persistence.sql', 'utf8');
    for (const statement of baseline.split(';').map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.prepare(`INSERT INTO situation_room_state
      (owner_id, state_json, revision, created_at, updated_at)
      VALUES ('legacy-owner', '{}', 1, '2026-09-01', '2026-09-01')`).run();
    const upgrade = await readFile('dist/dead_puck_situation_room/drizzle/0001_yahoo_auth_and_history.sql', 'utf8');
    for (const statement of upgrade.replaceAll('--> statement-breakpoint', '').split(';').map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const legacy = await db.prepare(`SELECT revision FROM situation_room_state WHERE owner_id = 'legacy-owner'`).first();
    assert.equal(legacy.revision, 1);
    const endpoint = 'http://localhost:8787/api/state';
    const state = (movesThisWeek) => ({ roster: [], waivers: [], schedule: {},
      selectedDate: '2026-09-26', movesThisWeek, yahoo: {} });
    const put = (movesThisWeek, baseRevision, clientChangeId) => mf.dispatchFetch(endpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state(movesThisWeek), baseRevision,
        change: { action: 'test-save', clientChangeId } }),
    });

    const invalid = await mf.dispatchFetch(endpoint, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: null, baseRevision: 0 }) });
    assert.equal(invalid.status, 400);

    const first = await put(0, 0, 'initial');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).revision, 1);
    const repeated = await put(0, 0, 'initial');
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).duplicate, true);

    const raced = await Promise.all([put(1, 1, 'race-one'), put(2, 1, 'race-two')]);
    assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409]);
    const changes = await (await mf.dispatchFetch('http://localhost:8787/api/changes')).json();
    assert.deepEqual(changes.changes.map((change) => change.revision), [2, 1]);
    assert.ok(changes.changes[0].before);
    assert.ok(changes.changes[0].after);
    const olderRetry = await put(0, 0, 'initial');
    assert.equal(olderRetry.status, 200);
    assert.equal((await olderRetry.json()).currentRevision, 2);
    const yahooStatus = await (await mf.dispatchFetch('http://localhost:8787/api/yahoo/status')).json();
    assert.equal(yahooStatus.configured, false);
    assert.equal((await mf.dispatchFetch('http://localhost:8787/api/yahoo/login')).status, 503);
  } finally {
    await mf.dispose();
  }
});
