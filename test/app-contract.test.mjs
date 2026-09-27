import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8');

test('every literal ID queried by app.js exists in index.html',()=>{
  const ids=[...app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m=>m[1]);
  const missing=[...new Set(ids)].filter(id=>!html.includes(`id="${id}"`));
  assert.deepEqual(missing,[]);
});

test('persistent build does not advertise browser-local storage as authoritative',()=>{
  assert.equal(html.includes('Saved locally'),false);
  assert.equal(html.includes('Reset local data'),false);
  assert.match(html,/ChatGPT Sites D1/);
});

test('production UI scripts and styles use content-hashed assets',()=>{
  const built=fs.readFileSync(new URL('../dist/client/index.html',import.meta.url),'utf8');
  assert.match(built,/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  assert.match(built,/\/assets\/index-[A-Za-z0-9_-]+\.css/);
  assert.equal(built.includes('/app.js'),false);
  assert.equal(fs.existsSync(new URL('../dist/client/app.js',import.meta.url)),false);
});

test('dormant Yahoo frontend routes have an explicit server fallback',()=>{
  assert.match(worker,/app\.get\("\/api\/yahoo\/status"/);
  assert.match(worker,/app\.all\("\/api\/yahoo\/\*"/);
  assert.match(worker,/YAHOO_NOT_CONFIGURED/);
});

test('state changes are unique per owner revision',()=>{
  const migration=fs.readFileSync(new URL('../drizzle/0001_change_revision_uniqueness.sql',import.meta.url),'utf8');
  assert.match(migration,/idx_situation_room_changes_owner_revision/);
  assert.match(migration,/owner_id, revision/);
});
