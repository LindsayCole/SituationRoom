import {
  ACTIVE_BENCH_CAPACITY,
  ACTIVE_SLOTS,
  addDays,
  analyzeCandidate,
  candidateScheduleMetrics,
  dayAvailability,
  gamesOn,
  hasProjectionValue,
  hasScheduleWindow,
  isGoalie,
  isReserve,
  isoDate,
  makeUuid,
  mondayOf,
  nightClass,
  optimizeDay,
  parsePlayerLines,
  parseRosterSnapshotLines,
  parsePositions,
  playerAvailability,
  projectWeek
} from './logic.js';

const STORAGE_KEY = 'deadPuckSituationRoom_v2';
const LEGACY_STORAGE_KEY = 'deadPuckSituationRoom_v1';
const PENDING_RECOVERY_KEY = 'deadPuckSituationRoom_pendingRecovery';

const league = {
  id: 46311,
  name: 'Blades of Glory Tokyo Drift',
  teamName: 'Dead Puck Society',
  firstScoringDate: '2026-09-29',
  teams: 12,
  scoringType: 'Head-to-Head - Points',
  maxAddsPerWeek: 5,
  waiverPriority: 6,
  waiverTimeDays: 2,
  waiverType: 'Continual rolling list',
  waiverMode: 'Standard',
  lineupDeadline: 'Daily - Today',
  minGoalieAppearances: 0,
  tradeDeadline: '2027-03-03',
  playoffTeams: 6,
  rosterSlots: ['C','C','LW','LW','RW','RW','D','D','D','D','UTIL','UTIL','G','G','BN','BN','BN','BN','IR','IR','IR+','IR+'],
  activeSlots: ACTIVE_SLOTS,
  skaterScoring: { G:3, A:2, PIM:0.3, PPP:1, SHP:1, GWG:1, SOG:0.3, HIT:0.3, BLK:0.3 },
  goalieScoring: { W:4, GA:-1, SV:0.2, SHO:3 },
  priorityLadder: [
    [1,"Wyatt & The Huckleberries"],
    [2,"Every Day I'm Scheif-eling"],
    [3,"Secret Lives Of Mormon By's"],
    [4,'The Drai Buds'],
    [5,'Makaroni & Cheese'],
    [6,'Dead Puck Society'],
    [7,"Gary's Goons"],
    [8,'Necas Libre'],
    [9,'Sour Grapes'],
    [10,'Lawrence of Arabia'],
    [11,'Brady is an Aho 😁'],
    [12,"Jmart's Bargain Bin Beauties"]
  ]
};

function defaultPlannerDate() {
  const today=isoDate(new Date());
  return today<league.firstScoringDate ? league.firstScoringDate : today;
}

const seedState = {
  roster: [],
  waivers: [],
  leagueRosters: [],
  movesThisWeek: 0,
  movesWeekStart: mondayOf(isoDate(new Date())),
  schedule: {},
  scheduleFetchedAt: null,
  selectedDate: defaultPlannerDate(),
  yahoo: {
    teamKey: null,
    leagueKey: null,
    lastSyncAt: null,
    leagueRostersAt: null,
    rosterDate: null,
    availableCount: 0,
    rosterSource: 'Manual / stored'
  }
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function nullableNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function fmtDate(dateStr) { return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); }
function fmtWhen(value) { return value ? new Date(value).toLocaleString() : 'Never'; }
function hasProjection(p) { return hasProjectionValue(p); }
function rosterProjectionComplete() {
  return state.roster.filter(p=>!isReserve(p)).every(hasProjection);
}
function projectionLabel(p) {
  if (!hasProjection(p)) return 'Projection needed';
  return p.projectionSource === 'manual' ? 'Manual' : p.projectionSource;
}

function projectionInputValue(p) {
  return hasProjection(p) ? String(Number(p.fppg)) : '';
}

function applyProjectionInput(player, rawValue) {
  const raw=String(rawValue ?? '').trim();
  if (!raw) {
    player.fppg=0;
    player.projectionSource='unset';
    player.projectionUpdatedAt=null;
    return;
  }
  const value=Number(raw);
  if (!Number.isFinite(value)) return;
  player.fppg=value;
  player.projectionSource='manual';
  player.projectionUpdatedAt=new Date().toISOString();
}
function ownershipLabel(p) {
  const raw = String(p?.ownershipType || '').toLowerCase();
  if (raw.includes('waiver')) return 'Waivers';
  if (raw.includes('free')) return 'Free agent';
  if (raw==='available') return 'Available · Yahoo';
  return 'Unverified';
}
function playerAvatar(p) {
  return p?.imageUrl
    ? `<img class="player-avatar" src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : '<span class="player-avatar player-avatar-placeholder">🏒</span>';
}
function statusBadge(p) {
  const status = String(p?.status || '').trim().toUpperCase();
  return status ? `<span class="badge status-badge">${esc(status)}</span>` : '<span class="mini-note">Active</span>';
}

function normalizeLoadedPlayer(p) {
  const positions = parsePositions((p.positions || []).join ? p.positions.join('/') : p.positions);
  const goalie = positions.includes('G');
  const core=Boolean(p.core);
  const yahooUndroppable=Boolean(p.yahooUndroppable);
  const manualCanDrop=p.manualCanDrop !== undefined
    ? Boolean(p.manualCanDrop)
    : core
      ? true
      : p.canDrop !== false;
  return {
    id: p.id || makeUuid(),
    name: String(p.name || 'Unknown player'),
    team: String(p.team || '').toUpperCase(),
    positions,
    fppg: Number(p.fppg) || 0,
    core,
    manualCanDrop,
    yahooUndroppable,
    canDrop: !core && manualCanDrop && !yahooUndroppable,
    selectedPosition: String(p.selectedPosition || 'BN').toUpperCase(),
    status: String(p.status || '').toUpperCase(),
    source: p.source || 'stored',
    yahooPlayerKey: p.yahooPlayerKey || null,
    yahooSeasonPoints: nullableNumber(p.yahooSeasonPoints),
    referencePoints: nullableNumber(p.referencePoints),
    referenceLabel: p.referenceLabel ? String(p.referenceLabel) : null,
    ownershipVerifiedAt: validTimestampOrNull(p.ownershipVerifiedAt),
    ownershipType: p.ownershipType || null,
    percentOwned: nullableNumber(p.percentOwned),
    waiverDate: p.waiverDate || null,
    imageUrl: p.imageUrl || null,
    projectionSource: p.projectionSource || (p.source === 'manual' ? 'manual' : 'unset'),
    projectionUpdatedAt: p.projectionUpdatedAt || null,
    startProbability: goalie ? Math.max(0,Math.min(1,Number(p.startProbability)||0)) : 1,
    goalieStartProbabilities: p.goalieStartProbabilities && typeof p.goalieStartProbabilities === 'object'
      ? p.goalieStartProbabilities
      : {}
  };
}

function isValidIsoDate(value) {
  const text=String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d=new Date(`${text}T12:00:00`);
  return !Number.isNaN(d.getTime()) && isoDate(d)===text;
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out={};
  for (const [date,value] of Object.entries(raw)) {
    if (!isValidIsoDate(date) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const gamesRaw=Number(value.games);
    const games=Number.isFinite(gamesRaw) ? Math.max(0,Math.trunc(gamesRaw)) : 0;
    const teams=Array.isArray(value.teams)
      ? [...new Set(value.teams.map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))]
      : [];
    out[date]={games,teams};
  }
  return out;
}

function validTimestampOrNull(value) {
  if (!value) return null;
  const d=new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function migrateLegacy(legacy) {
  return normalizeState(legacy);
}

function normalizeState(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const moves=Number(source.movesThisWeek);
  const rawYahoo=source.yahoo && typeof source.yahoo === 'object' && !Array.isArray(source.yahoo)
    ? source.yahoo
    : {};
  return {
    ...clone(seedState),
    ...source,
    roster: Array.isArray(source.roster) ? source.roster.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(normalizeLoadedPlayer) : clone(seedState.roster),
    waivers: Array.isArray(source.waivers) ? source.waivers.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(normalizeLoadedPlayer) : [],
    leagueRosters: Array.isArray(source.leagueRosters)
      ? source.leagueRosters.filter(x=>x&&typeof x==='object'&&!Array.isArray(x) && x.name)
        .map(x=>({teamKey:x.teamKey||null,name:String(x.name),source:x.source||'manual',
          updatedAt:validTimestampOrNull(x.updatedAt),
          players:Array.isArray(x.players)?x.players.filter(p=>p&&typeof p==='object'&&!Array.isArray(p)).map(normalizeLoadedPlayer):[]}))
      : [],
    movesThisWeek:Number.isFinite(moves)?Math.max(0,Math.min(league.maxAddsPerWeek,Math.trunc(moves))):0,
    movesWeekStart:isValidIsoDate(source.movesWeekStart)?source.movesWeekStart:mondayOf(isoDate(new Date())),
    schedule:normalizeSchedule(source.schedule),
    scheduleFetchedAt:validTimestampOrNull(source.scheduleFetchedAt),
    selectedDate:isValidIsoDate(source.selectedDate)?source.selectedDate:defaultPlannerDate(),
    yahoo:{
      ...clone(seedState.yahoo),
      ...rawYahoo,
      lastSyncAt:validTimestampOrNull(rawYahoo.lastSyncAt),
      leagueRostersAt:validTimestampOrNull(rawYahoo.leagueRostersAt)
    }
  };
}

function loadBrowserStateForMigration() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { state:normalizeState(JSON.parse(raw)), source:'v2-browser' };
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) return { state:migrateLegacy(JSON.parse(legacyRaw)), source:'v1-browser' };
  } catch (err) {
    console.warn('Legacy browser state could not be read.', err);
  }
  return null;
}

function readPendingRecovery() {
  try {
    const raw=localStorage.getItem(PENDING_RECOVERY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Pending recovery state could not be read.',err);
    return null;
  }
}

let state = clone(seedState);
let stateRevision = 0;
let stateUpdatedAt = null;
let pendingSaves = [];
let saveDrainPromise = null;
let historyRows = [];
let syncRows = [];
let yahooStatus = { configured:false, connected:false, writeEnabled:false, readOnlyDefault:true };
let storageError = '';
let storageConflict = false;

function makeSaveEntry(change={}, snapshot=clone(state)) {
  return {
    snapshot,
    change:{
      source:change.source || 'manual',
      action:change.action || 'state-update',
      entityType:change.entityType || null,
      entityId:change.entityId || null,
      before:change.before,
      after:change.after,
      metadata:change.metadata,
      clientChangeId:change.clientChangeId || makeUuid()
    }
  };
}

function persistRecoveryCopy(failedAt=null) {
  if (!pendingSaves.length) {
    localStorage.removeItem(PENDING_RECOVERY_KEY);
    return;
  }
  const latest=pendingSaves[pendingSaves.length-1];
  const pendingChanges=pendingSaves.map(entry=>({
    source:entry.change.source,
    action:entry.change.action,
    entityType:entry.change.entityType,
    entityId:entry.change.entityId,
    before:entry.change.before,
    after:entry.change.after,
    metadata:entry.change.metadata,
    clientChangeId:entry.change.clientChangeId,
    snapshot:entry.snapshot
  }));
  try {
    localStorage.setItem(PENDING_RECOVERY_KEY,JSON.stringify({
      version:3,
      state:latest.snapshot,
      baseRevision:stateRevision,
      pendingChanges,
      failedAt:failedAt || new Date().toISOString()
    }));
  } catch (err) {
    console.warn('Emergency recovery copy could not be written.',err);
  }
}

function enterRecoveryConflict(recovery, message) {
  state=normalizeState(recovery.state);
  storageConflict=true;
  storageError=message;
  $('#saveStatus').textContent='Recovery conflict · browser copy loaded';
}

async function replayRecovery(recovery, hasStoredState) {
  if (!recovery?.state) return true;
  const desired=normalizeState(recovery.state);
  const base=Number(recovery.baseRevision);
  const hasBase=Number.isInteger(base) && base>=0;
  const changes=Array.isArray(recovery.pendingChanges)
    ? recovery.pendingChanges.filter(x=>x&&typeof x==='object')
    : [];

  // Compatibility with the earlier recovery format. It is safe to restore
  // automatically only when there is no authoritative Site state yet.
  if (!hasBase || !changes.length) {
    if (hasStoredState) {
      enterRecoveryConflict(
        recovery,
        'An older browser recovery copy exists alongside stored Site data. Export the recovered view if needed, then use “Reload Site state” to keep the authoritative version.'
      );
      return false;
    }
    state=desired;
    const saved=await saveState({
      source:'system',
      action:'recovery-restore',
      metadata:{recoveredFrom:recovery.failedAt || null}
    });
    if (saved) localStorage.removeItem(PENDING_RECOVERY_KEY);
    return saved;
  }

  if (stateRevision < base) {
    enterRecoveryConflict(
      recovery,
      'The recovery copy was created from a newer revision than this Site currently reports. It was not replayed automatically.'
    );
    return false;
  }

  let applied=0;
  if (stateRevision > base) {
    if (stateRevision-base > 250) {
      enterRecoveryConflict(
        recovery,
        'The Site advanced too far beyond the recovery base to verify the pending change sequence safely.'
      );
      return false;
    }
    const history=await fetchJson('/api/changes?limit=250');
    const byRevision=new Map((history.changes||[]).map(row=>[Number(row.revision),row]));
    for (let i=0;i<changes.length;i++) {
      const row=byRevision.get(base+i+1);
      if (row?.clientChangeId && row.clientChangeId===changes[i].clientChangeId) applied++;
      else break;
    }
    if (stateRevision !== base+applied) {
      enterRecoveryConflict(
        recovery,
        'The Site contains changes that are not the verified prefix of this browser recovery queue. The recovered view is preserved, but it was not allowed to overwrite newer state.'
      );
      return false;
    }
  }

  if (applied===changes.length) {
    localStorage.removeItem(PENDING_RECOVERY_KEY);
    return true;
  }

  state=desired;
  for (const change of changes.slice(applied)) {
    pendingSaves.push(makeSaveEntry(change,normalizeState(change.snapshot || desired)));
  }
  persistRecoveryCopy(recovery.failedAt || null);
  $('#saveStatus').textContent='Replaying recovered saves…';
  const saved=await drainSaveQueue();
  if (saved) localStorage.removeItem(PENDING_RECOVERY_KEY);
  return saved;
}

async function loadPersistedState() {
  $('#saveStatus').textContent = 'Loading Site storage…';
  const recovery=readPendingRecovery();
  const stored = await fetchJson('/api/state');

  if (stored.state) {
    state = normalizeState(stored.state);
    stateRevision = Number(stored.revision) || 0;
    stateUpdatedAt = stored.updatedAt || null;
    $('#saveStatus').textContent = `Saved to Site · rev ${stateRevision}`;
    if (recovery?.state) await replayRecovery(recovery,true);
    return;
  }

  stateRevision=0;
  stateUpdatedAt=null;
  if (recovery?.state) {
    const restored=await replayRecovery(recovery,false);
    if (!restored) throw new Error(storageError || 'Recovered Site state could not be saved.');
    return;
  }

  const browser = loadBrowserStateForMigration();
  state = browser?.state || clone(seedState);
  const saved = await saveState({
    source:'system',
    action:browser ? 'migrate-browser-state' : 'initialize-state',
    metadata:{browserSource:browser?.source || null}
  });
  if (!saved) throw new Error(storageError || 'Initial Site state could not be saved.');
  if (browser) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

function saveState(change={}) {
  pendingSaves.push(makeSaveEntry(change));
  persistRecoveryCopy();
  $('#saveStatus').textContent = storageConflict ? 'Save blocked by conflict' : 'Saving to Site…';
  return drainSaveQueue();
}

function drainSaveQueue() {
  if (saveDrainPromise) return saveDrainPromise;
  if (storageConflict) {
    renderPersistenceStatus();
    return Promise.resolve(false);
  }

  saveDrainPromise=(async()=>{
    while (pendingSaves.length) {
      const entry=pendingSaves[0];
      try {
        const result=await fetchJson('/api/state',{
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            state:entry.snapshot,
            baseRevision:stateRevision,
            change:entry.change
          })
        });

        stateRevision=Number(result.revision) || stateRevision;
        stateUpdatedAt=result.updatedAt || new Date().toISOString();
        pendingSaves.shift();
        storageError='';
        storageConflict=false;
        if (!result.duplicate) historyRows.unshift({
          id:result.changeId || entry.change.clientChangeId,
          revision:stateRevision,
          source:entry.change.source,
          action:entry.change.action,
          entityType:entry.change.entityType,
          entityId:entry.change.entityId,
          metadata:entry.change.metadata || null,
          clientChangeId:entry.change.clientChangeId,
          createdAt:stateUpdatedAt
        });
        historyRows=historyRows.slice(0,100);
        persistRecoveryCopy();
        $('#saveStatus').textContent = `Saved to Site · rev ${stateRevision}`;
        renderPersistenceStatus();
        renderHistory();
      } catch (err) {
        storageError=err.message || 'Site save failed.';
        storageConflict=err.status===409;
        persistRecoveryCopy(new Date().toISOString());
        $('#saveStatus').textContent = storageConflict
          ? 'Save conflict · recovery copy kept in browser'
          : 'Save failed · recovery copy kept in browser';
        renderPersistenceStatus();
        return false;
      }
    }
    return true;
  })().finally(()=>{ saveDrainPromise=null; });

  return saveDrainPromise;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error:text || `HTTP ${res.status}` }; }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function fetchXml(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    try { throw new Error(JSON.parse(text).error || `HTTP ${res.status}`); }
    catch (err) { if (err instanceof SyntaxError) throw new Error(text || `HTTP ${res.status}`); throw err; }
  }
  const doc = new DOMParser().parseFromString(text,'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Yahoo returned XML that could not be parsed.');
  return doc;
}

function directChild(el, localName) {
  return [...(el?.children || [])].find(x=>x.localName===localName) || null;
}
function directText(el, localName) {
  return directChild(el, localName)?.textContent?.trim() || '';
}
function nestedText(el, parentName, childName) {
  const parent = directChild(el,parentName);
  return directText(parent,childName);
}
function nestedPositions(el, parentName='eligible_positions') {
  const parent = directChild(el,parentName);
  if (!parent) return [];
  return [...parent.children].filter(x=>x.localName==='position').map(x=>x.textContent.trim());
}

function parseYahooTeams(doc) {
  return [...doc.getElementsByTagNameNS('*','team')].map(team=>({
    teamKey: directText(team,'team_key'),
    teamId: directText(team,'team_id'),
    name: directText(team,'name')
  })).filter(x=>x.teamKey);
}

function parseYahooPlayers(doc, source='yahoo') {
  const players=[];
  for (const el of doc.getElementsByTagNameNS('*','player')) {
    const playerKey = directText(el,'player_key');
    if (!playerKey) continue;
    const nameEl = directChild(el,'name');
    const fullName = directText(nameEl,'full') || directText(el,'display_name') || playerKey;
    const rawEligible = nestedPositions(el);
    let positions = parsePositions(rawEligible.join('/'));
    if (!positions.length) positions = parsePositions(directText(el,'display_position'));
    const selectedEl = directChild(el,'selected_position');
    const selectedPosition = directText(selectedEl,'position') || 'BN';
    const status = directText(el,'status') || directText(el,'status_full');
    const seasonPointsRaw = nestedText(el,'player_points','total');
    const seasonPoints = seasonPointsRaw === '' ? null : Number(seasonPointsRaw);
    const ownershipEl = directChild(el,'ownership');
    const percentEl = directChild(el,'percent_owned');
    const percentValue = percentEl ? nullableNumber(directText(percentEl,'value')) : null;
    const imageUrl = directText(el,'image_url') || nestedText(el,'headshot','url') || null;
    const waiverDate = ownershipEl ? (directText(ownershipEl,'waiver_date') || null) : null;
    const yahooUndroppable = directText(el,'is_undroppable') === '1';
    players.push({
      id: makeUuid(),
      yahooPlayerKey: playerKey,
      name: fullName,
      team: directText(el,'editorial_team_abbr').toUpperCase(),
      positions,
      selectedPosition,
      status,
      fppg: 0,
      core:false,
      manualCanDrop:true,
      yahooUndroppable,
      canDrop: !yahooUndroppable,
      source,
      yahooSeasonPoints: Number.isFinite(seasonPoints) ? seasonPoints : null,
      ownershipType: ownershipEl ? directText(ownershipEl,'ownership_type') :
        (source==='yahoo-available'||source==='yahoo-search' ? 'available' : null),
      percentOwned: percentValue,
      waiverDate,
      imageUrl,
      projectionSource:'unset',
      projectionUpdatedAt:null,
      startProbability: positions.includes('G') ? 0 : 1,
      goalieStartProbabilities: {}
    });
  }
  return players;
}

function playerFallbackIdentity(player) {
  return `${String(player?.name||'').trim().toLowerCase()}|${String(player?.team||'').trim().toUpperCase()}`;
}

function findExistingPlayer(collection, incoming) {
  if (incoming?.yahooPlayerKey) {
    const keyed=collection.find(p=>p.yahooPlayerKey===incoming.yahooPlayerKey);
    if (keyed) return keyed;
  }
  const identity=playerFallbackIdentity(incoming);
  return collection.find(p=>playerFallbackIdentity(p)===identity) || null;
}

function mergeYahooRoster(yahooPlayers) {
  return yahooPlayers.map(p=>{
    const old = findExistingPlayer(state.roster,p);
    return normalizeLoadedPlayer({
      ...p,
      id: old?.id || p.id,
      referencePoints: old?.referencePoints ?? null,
      referenceLabel: old?.referenceLabel ?? null,
      fppg: Number(old?.fppg) || 0,
      projectionSource: old?.projectionSource || 'unset',
      projectionUpdatedAt: old?.projectionUpdatedAt || null,
      core: old?.core || false,
      manualCanDrop: old?.manualCanDrop !== undefined
        ? old.manualCanDrop
        : old?.core
          ? true
          : old?.canDrop !== false,
      yahooUndroppable: Boolean(p.yahooUndroppable),
      startProbability: isGoalie(p) ? (Number(old?.startProbability)||0) : 1,
      goalieStartProbabilities: old?.goalieStartProbabilities || {}
    });
  });
}

function mergeYahooWaivers(yahooPlayers) {
  return yahooPlayers.map(p=>{
    const old = findExistingPlayer(state.waivers,p);
    return normalizeLoadedPlayer({
      ...p,
      id: old?.id || p.id,
      fppg: Number(old?.fppg) || 0,
      projectionSource: old?.projectionSource || 'unset',
      projectionUpdatedAt: old?.projectionUpdatedAt || null,
      core:false,
      manualCanDrop:true,
      yahooUndroppable:Boolean(p.yahooUndroppable),
      startProbability: isGoalie(p) ? (Number(old?.startProbability)||0) : 1,
      goalieStartProbabilities: old?.goalieStartProbabilities || {}
    });
  });
}

function replaceYahooWaiverPool(yahooPlayers) {
  const merged=mergeYahooWaivers(yahooPlayers);
  const matchedIdentities=new Set(merged.map(playerFallbackIdentity));
  const manualUnmatched=state.waivers.filter(p=>!p.yahooPlayerKey && !matchedIdentities.has(playerFallbackIdentity(p)));
  return [...manualUnmatched,...merged];
}

function mergeYahooSearchIntoWaiverPool(yahooPlayers) {
  const incoming=mergeYahooWaivers(yahooPlayers);
  const incomingKeys=new Set(incoming.map(p=>p.yahooPlayerKey).filter(Boolean));
  const incomingIdentities=new Set(incoming.map(playerFallbackIdentity));
  const retained=state.waivers.filter(p=>{
    if (p.yahooPlayerKey) return !incomingKeys.has(p.yahooPlayerKey);
    return !incomingIdentities.has(playerFallbackIdentity(p));
  });
  return [...retained,...incoming];
}

function scheduleDaysFromResponse(data) {
  const out={};
  for (const day of (data?.gameWeek || [])) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || ''))) continue;
    const teams=[];
    for (const g of (day.games || [])) {
      const away=(g.awayTeam?.abbrev||'').toUpperCase();
      const home=(g.homeTeam?.abbrev||'').toUpperCase();
      if (away) teams.push(away);
      if (home) teams.push(home);
    }
    out[day.date]={games:(day.games||[]).length,teams:[...new Set(teams)]};
  }
  return out;
}

async function refreshSchedule() {
  const btn = $('#refreshScheduleBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  $('#scheduleStatus').textContent = 'NHL schedule: loading';
  try {
    const start = state.selectedDate || isoDate(new Date());
    const required=Array.from({length:7},(_,i)=>addDays(start,i));
    const first=await fetchJson(`/api/nhl/schedule?date=${encodeURIComponent(start)}`);
    const fetched=scheduleDaysFromResponse(first);

    let missing=required.filter(date=>!Object.prototype.hasOwnProperty.call(fetched,date));
    for (const date of missing) {
      const extra=await fetchJson(`/api/nhl/schedule?date=${encodeURIComponent(date)}`);
      Object.assign(fetched,scheduleDaysFromResponse(extra));
    }

    missing=required.filter(date=>!Object.prototype.hasOwnProperty.call(fetched,date));
    if (missing.length) {
      throw new Error(`NHL schedule response did not confirm these dates: ${missing.join(', ')}. Existing stored schedule was left unchanged.`);
    }

    const schedule={...state.schedule};
    for (const date of required) schedule[date]=fetched[date];
    state.schedule = schedule;
    state.scheduleFetchedAt = new Date().toISOString();
    const saved=await saveState({
      source:'nhl',
      action:'schedule-refresh',
      metadata:{selectedDate:start,dates:required}
    });
    renderAll();
    if (!saved) alert('The NHL schedule loaded into the recovery copy, but could not be saved to Site storage. Use History / Storage to retry.');
  } catch (err) {
    $('#scheduleStatus').textContent = 'NHL schedule: refresh failed';
    alert(`Could not load the NHL schedule. Saved data was not changed.\n\n${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh NHL schedule';
  }
}

async function loadHistory() {
  try {
    const [changes,syncRuns] = await Promise.all([
      fetchJson('/api/changes?limit=100'),fetchJson('/api/sync-runs')
    ]);
    historyRows = Array.isArray(changes.changes) ? changes.changes : [];
    syncRows = Array.isArray(syncRuns.syncRuns) ? syncRuns.syncRuns : [];
  } catch (err) {
    console.warn('Change history could not be loaded.',err);
  }
  renderHistory();
}

function renderPersistenceStatus(errorText=storageError) {
  const pill=$('#siteStorageStatus');
  const status=$('#storageStatusText');
  const rev=$('#storageRevision');
  const updated=$('#storageUpdatedAt');
  if (!pill || !status || !rev || !updated) return;

  const retryBtn=$('#retryStorageBtn');
  const reloadBtn=$('#reloadSiteStateBtn');
  if (retryBtn) retryBtn.hidden=!errorText || storageConflict;
  if (reloadBtn) reloadBtn.hidden=!storageConflict;

  if (errorText) {
    pill.textContent=storageConflict?'Site storage: conflict':'Site storage: attention';
    pill.className='status-pill status-warn';
    status.textContent=errorText;
  } else if (pendingSaves.length || readPendingRecovery()) {
    pill.textContent='Site storage: unsaved edits';
    pill.className='status-pill status-warn';
    status.textContent='Recovery copies are waiting on this device. Review them before discarding.';
  } else {
    pill.textContent=`Site storage: saved · r${stateRevision}`;
    pill.className='status-pill good';
    status.textContent='D1 is the authoritative store. Browser storage is used only as emergency recovery for a failed save.';
  }
  rev.textContent=String(stateRevision);
  updated.textContent=fmtWhen(stateUpdatedAt);
}

function renderHistory() {
  const body=$('#historyTable');
  const syncBody=$('#syncHistoryTable');
  if (syncBody) {
    syncBody.innerHTML=syncRows.length
      ? syncRows.map(row=>`<tr><td>${esc(fmtWhen(row.completedAt||row.startedAt))}</td><td>${esc(row.status)}</td><td>${esc(row.error || JSON.stringify(row.summary||{}))}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">No Yahoo sync attempts yet.</td></tr>';
  }
  if (!body) return;
  body.innerHTML='';
  if (!historyRows.length) {
    body.innerHTML='<tr><td colspan="5" class="muted">No stored changes yet.</td></tr>';
    return;
  }
  for (const row of historyRows) {
    const detail=[row.entityType,row.entityId].filter(Boolean).join(' · ')
      || (row.metadata ? JSON.stringify(row.metadata).slice(0,120) : '—');
    body.insertAdjacentHTML('beforeend',`<tr><td>r${Number(row.revision)||0}</td><td>${esc(fmtWhen(row.createdAt))}</td><td>${esc(row.source||'manual')}</td><td><strong>${esc(row.action||'state-update')}</strong></td><td class="mini-note">${esc(detail)}</td></tr>`);
  }
}

async function loadYahooStatus() {
  try {
    yahooStatus = await fetchJson('/api/yahoo/status');
  } catch (err) {
    yahooStatus = {configured:false,connected:false,writeEnabled:false,readOnlyDefault:true,error:err.message};
  }
  renderYahooStatus();
}

function renderYahooStatus() {
  const header = $('#yahooHeaderStatus');
  const panel = $('#yahooPanelStatus');
  const connect = $('#connectYahooBtn');
  const sync = $('#syncYahooBtn');
  const disconnect = $('#disconnectYahooBtn');
  const headerSync = $('#syncYahooHeaderBtn');
  const text = $('#yahooConnectionText');

  if (!yahooStatus.configured) {
    header.textContent = 'Yahoo: not configured';
    panel.textContent = 'Not configured';
    panel.className = 'status-pill status-warn';
    connect.hidden = false; sync.hidden = true; disconnect.hidden = true; headerSync.hidden = true;
    connect.disabled = true;
    const missing = yahooStatus.missingConfig?.length ? ` Missing: ${yahooStatus.missingConfig.join(', ')}.` : '';
    text.textContent = yahooStatus.message || ('Yahoo credentials are not configured yet.' + missing);
  } else if (!yahooStatus.connected) {
    header.textContent = 'Yahoo: disconnected';
    panel.textContent = 'Disconnected';
    panel.className = 'status-pill status-warn';
    connect.hidden = false; sync.hidden = true; disconnect.hidden = true; headerSync.hidden = true;
    connect.disabled = false;
    text.textContent = yahooStatus.error ? `Yahoo needs to be reconnected: ${yahooStatus.error}` : 'OAuth is configured. Connect Yahoo to authorize read access to your fantasy data.';
  } else {
    header.textContent = 'Yahoo: connected';
    panel.textContent = 'Connected · read sync ready';
    panel.className = 'status-pill good';
    connect.hidden = true; sync.hidden = false; disconnect.hidden = false; headerSync.hidden = false;
    text.textContent = 'Yahoo is connected. Syncing reads your fantasy team and available-player data into the stored Situation Room model.';
  }
  $('#writeAccessText').textContent = yahooStatus.writeEnabled
    ? 'Feature flag is enabled, but this v2 alpha still exposes no write endpoints. Yahoo approval must be confirmed first.'
    : 'Disabled. Yahoo currently provisions Fantasy API access as read-only by default.';
  $('#lastYahooSync').textContent = fmtWhen(state.yahoo.lastSyncAt);
  $('#teamKeyValue').textContent = state.yahoo.teamKey || '—';
  $('#leagueKeyValue').textContent = state.yahoo.leagueKey || '—';
  $('#rosterSourceValue').textContent = state.yahoo.rosterSource || 'local';
  $('#rosterDateValue').textContent = state.yahoo.rosterDate || '—';
  $('#yahooRedirectUri').textContent = yahooStatus.redirectUri || 'Set YAHOO_REDIRECT_URI in Site settings';
  $('#yahooMissingConfig').textContent = yahooStatus.configured ? 'Configured' : yahooStatus.missingConfig?.join(', ') || 'Yahoo Site settings missing';
  const searchBtn=$('#searchYahooPlayersBtn');
  const searchInput=$('#yahooPlayerSearch');
  const positionInput=$('#yahooPositionSearch');
  const yahooSearchReady=Boolean(yahooStatus.connected);
  if (searchBtn) searchBtn.disabled=!yahooSearchReady;
  if (searchInput) searchInput.disabled=!yahooSearchReady;
  if (positionInput) positionInput.disabled=!yahooSearchReady;

}

async function syncYahoo() {
  if (!yahooStatus.connected) return;
  const buttons = [$('#syncYahooBtn'),$('#syncYahooHeaderBtn')];
  buttons.forEach(b=>{b.disabled=true;b.textContent='Syncing…';});
  const log = $('#yahooSyncLog');
  log.className = 'action-banner';
  log.textContent = 'Discovering your Yahoo NHL team…';
  try {
    const teamsDoc = await fetchXml('/api/yahoo/teams');
    const teams = parseYahooTeams(teamsDoc);
    const leagueFragment = `.l.${league.id}.`;
    const team = teams.find(t=>t.teamKey.includes(leagueFragment)) || teams.find(t=>t.name.toLowerCase()===league.teamName.toLowerCase());
    if (!team) throw new Error(`Could not find ${league.teamName} in Yahoo league ${league.id}.`);
    const leagueKey = team.teamKey.split('.t.')[0];

    const rosterDate = isoDate(new Date());
    log.textContent = `Syncing current roster for ${rosterDate}…`;
    const rosterDoc = await fetchXml(`/api/yahoo/roster?teamKey=${encodeURIComponent(team.teamKey)}&date=${encodeURIComponent(rosterDate)}`);
    const rosterPlayers = parseYahooPlayers(rosterDoc,'yahoo-roster');
    if (!rosterPlayers.length) throw new Error('Yahoo roster response contained no players.');
    const nextRoster = mergeYahooRoster(rosterPlayers);

    log.textContent = 'Loading available players…';
    const [availableDoc0, availableDoc50] = await Promise.all([
      fetchXml(`/api/yahoo/available?leagueKey=${encodeURIComponent(leagueKey)}&status=A&start=0&count=50`),
      fetchXml(`/api/yahoo/available?leagueKey=${encodeURIComponent(leagueKey)}&status=A&start=50&count=50`)
    ]);
    const available = [...parseYahooPlayers(availableDoc0,'yahoo-available'), ...parseYahooPlayers(availableDoc50,'yahoo-available')];
    const seen = new Set();
    const nextWaivers = replaceYahooWaiverPool(available.filter(p=>p.yahooPlayerKey && !seen.has(p.yahooPlayerKey) && seen.add(p.yahooPlayerKey)));

    state.roster = nextRoster;
    state.waivers = nextWaivers;
    state.yahoo.teamKey = team.teamKey;
    state.yahoo.leagueKey = leagueKey;
    state.yahoo.lastSyncAt = new Date().toISOString();
    state.yahoo.rosterDate = rosterDate;
    state.yahoo.availableCount = state.waivers.length;
    state.yahoo.rosterSource = 'Yahoo Fantasy';
    const saved=await saveState({source:'yahoo',action:'yahoo-sync',metadata:{rosterCount:state.roster.length,availableCount:state.waivers.length,rosterDate}});
    if (!saved) throw new Error(storageError || 'Yahoo data loaded but could not be persisted.');
    renderAll();
    log.className = 'action-banner good';
    const rosterPoints = state.roster.filter(p=>p.yahooSeasonPoints !== null).length;
    const poolPoints = state.waivers.filter(p=>p.yahooSeasonPoints !== null).length;
    log.textContent = `Yahoo sync complete: ${state.roster.length} roster players (${rosterPoints} with Yahoo points) and ${state.waivers.length} available players (${poolPoints} with Yahoo points).`;
  } catch (err) {
    log.className = 'action-banner warn';
    log.textContent = `Yahoo sync failed: ${err.message}`;
    try { await fetchJson('/api/yahoo/sync-failure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:err.message})}); }
    catch (historyError) { console.warn('Yahoo failure could not be recorded.',historyError); }
    await loadHistory();
    if (/not connected|401/i.test(err.message)) await loadYahooStatus();
  } finally {
    buttons.forEach((b,i)=>{b.disabled=false;b.textContent=i===0?'Sync now':'Sync Yahoo';});
  }
}


async function searchYahooPlayers() {
  if (!yahooStatus.connected || !state.yahoo.leagueKey) {
    alert('Connect and sync Yahoo first so the league key is known.');
    return;
  }
  const input = $('#yahooPlayerSearch');
  const query = input.value.trim();
  if (query.length < 2) {
    alert('Enter at least two characters of a player name.');
    return;
  }
  const position = $('#yahooPositionSearch').value;
  const btn = $('#searchYahooPlayersBtn');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  try {
    const params = new URLSearchParams({
      leagueKey:state.yahoo.leagueKey,
      status:'A',
      start:'0',
      count:'25',
      search:query
    });
    if (position) params.set('position',position);
    const doc = await fetchXml('/api/yahoo/available?' + params.toString());
    const incoming = parseYahooPlayers(doc,'yahoo-search');
    state.waivers = mergeYahooSearchIntoWaiverPool(incoming);
    state.yahoo.availableCount = state.waivers.length;
    const saved=await saveState({source:'yahoo',action:'yahoo-player-search',metadata:{query,position,matched:incoming.length}});
    if (!saved) throw new Error(storageError || 'Yahoo search results could not be persisted.');
    renderAll();
    $('#yahooSyncLog').className = 'action-banner good';
    $('#yahooSyncLog').textContent = incoming.length
      ? `Yahoo search added/refreshed ${incoming.length} matching available player${incoming.length===1?'':'s'}.`
      : `Yahoo returned no available players matching “${query}”.`;
  } catch (err) {
    $('#yahooSyncLog').className = 'action-banner warn';
    $('#yahooSyncLog').textContent = `Yahoo player search failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search Yahoo';
  }
}

function rosterCounts() {
  const reserve = state.roster.filter(isReserve).length;
  return { reserve, activeBench:state.roster.length-reserve };
}

function renderSeasonReadiness() {
  const projected=state.roster.filter(p=>!isReserve(p) && hasProjection(p)).length;
  const active=state.roster.filter(p=>!isReserve(p)).length;
  const scheduleDays=Array.from({length:7},(_,i)=>addDays(state.selectedDate,i))
    .filter(date=>Object.prototype.hasOwnProperty.call(state.schedule,date)).length;
  const confirmed=state.waivers.filter(p=>['available','free-agent','waivers']
    .includes(playerAvailability(p,state.roster,state.leagueRosters).status)).length;
  const tracked=state.leagueRosters.filter(team=>team.players.length).length;
  const goalies=state.roster.filter(isGoalie);
  const goalieChances=goalies.filter(p=>Number(p.startProbability)>0).length;
  const items=[
    ['Roster',`${active} / ${ACTIVE_BENCH_CAPACITY} active + bench`,'roster'],
    ['Projections',`${projected} / ${active} ready`,'roster'],
    ['NHL schedule',`${scheduleDays} / 7 dates loaded`,'week'],
    ['Goalie chances',`${goalieChances} / ${goalies.length} set`,'roster'],
    ['Available pool',`${confirmed} confirmed candidates`,'waivers'],
    ['Other teams',`${tracked} / ${league.teams-1} rosters tracked`,'league-rosters'],
  ];
  $('#seasonReadiness').innerHTML=items.map(([title,value,tab])=>
    `<button class="readiness-card" data-open-tab="${tab}"><span>${esc(title)}</span><strong>${esc(value)}</strong></button>`).join('');
}

function currentMovesUsed() {
  return state.movesWeekStart===mondayOf(isoDate(new Date())) ? state.movesThisWeek : 0;
}

function renderKPIs() {
  const w = projectWeek(state.roster,state.schedule,state.selectedDate,league.activeSlots);
  const counts = rosterCounts();
  $('#kpiMoves').textContent = `${Math.max(0,league.maxAddsPerWeek-currentMovesUsed())} / ${league.maxAddsPerWeek}`;
  $('#kpiPriority').textContent = `#${league.waiverPriority}`;
  $('#kpiRoster').textContent = `${counts.activeBench} / ${ACTIVE_BENCH_CAPACITY}`;
  $('#kpiReserve').textContent = `${counts.reserve} reserve`;
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const projectionsReady=rosterProjectionComplete();
  $('#kpiUsable').textContent = scheduleReady ? w.usableGames.toFixed(1) : '—';
  $('#kpiPoints').textContent = scheduleReady && projectionsReady ? w.points.toFixed(1) : '—';
  $('#kpiLeakage').textContent = scheduleReady && projectionsReady ? w.leakage.toFixed(1) : '—';
}

function renderScheduleStatus() {
  const ready=hasScheduleWindow(state.schedule,state.selectedDate);
  $('#scheduleStatus').textContent = ready && state.scheduleFetchedAt
    ? 'NHL schedule: ' + new Date(state.scheduleFetchedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
    : state.scheduleFetchedAt
      ? 'NHL schedule: refresh selected week'
      : 'NHL schedule: not loaded';
}

function renderToday() {
  const date = $('#todayDate').value || state.selectedDate;
  const r = optimizeDay(state.roster,state.schedule,date,league.activeSlots);
  const body = $('#todayStarters');
  body.innerHTML = '';
  if (!state.schedule[date]) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No NHL schedule data loaded for ${esc(date)}.</td></tr>`;
    $('#todayBench').className = 'stack-list empty-state';
    $('#todayBench').textContent = 'Refresh the NHL schedule first.';
    $('#todayActionBanner').className = 'action-banner';
    $('#todayActionBanner').textContent = 'Load the NHL schedule to calculate usable starts.';
    return;
  }

  const bySlot = new Map(r.starters.map(x=>[x.slotIndex,x.player]));
  league.activeSlots.forEach((slot,idx)=>{
    const p = bySlot.get(idx);
    const projected=p ? hasProjection(p) : false;
    body.insertAdjacentHTML('beforeend', p
      ? `<tr><td><span class="badge">${slot}</span></td><td><strong>${esc(p.name)}</strong></td><td>${esc(p.team)}</td><td>${esc((p.positions||[]).join('/'))}</td><td>${projected?Number(p.fppg).toFixed(2):'—'}</td><td>${projected?(p.fppg*p.availability).toFixed(2):'—'}</td></tr>`
      : `<tr><td><span class="badge">${slot}</span></td><td class="muted">Open</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`
    );
  });

  const attention = $('#todayBench');
  attention.className = 'stack-list';
  attention.innerHTML = '';
  const missingProjection=r.scheduled.filter(p=>!hasProjection(p));
  for (const p of missingProjection) {
    attention.insertAdjacentHTML('beforeend',`<div class="stack-item"><div><strong>${esc(p.name)}</strong><div class="mini-note">${esc(p.team)} plays · projection needed</div></div><div><span class="badge">?</span></div></div>`);
  }
  for (const p of r.blocked.sort((a,b)=>(b.fppg*b.availability)-(a.fppg*a.availability))) {
    const projected=hasProjection(p);
    attention.insertAdjacentHTML('beforeend',`<div class="stack-item"><div><strong>${esc(p.name)}</strong><div class="mini-note">${esc(p.team)} · blocked by lineup congestion</div></div><div><strong>${projected?(p.fppg*p.availability).toFixed(2):'—'}</strong><div class="mini-note">${projected?'expected pts':'projection needed'}</div></div></div>`);
  }
  for (const p of r.goalieUnconfirmed) {
    attention.insertAdjacentHTML('beforeend',`<div class="stack-item"><div><strong>${esc(p.name)}</strong><div class="mini-note">${esc(p.team)} plays · goalie start unconfirmed</div></div><div><span class="badge">G</span></div></div>`);
  }
  if (!missingProjection.length && !r.blocked.length && !r.goalieUnconfirmed.length) {
    attention.className = 'stack-list empty-state';
    attention.textContent = 'No lineup congestion or unconfirmed goalie starts flagged.';
  }

  const banner = $('#todayActionBanner');
  if (missingProjection.length) {
    banner.className='action-banner warn';
    banner.innerHTML=`<strong>Lineup ranking is provisional.</strong> ${missingProjection.length} scheduled player${missingProjection.length===1?' is':'s are'} missing a projection, so projected points and congestion value are incomplete.`;
  } else if (r.blocked.length) {
    banner.className='action-banner warn';
    banner.innerHTML=`<strong>${r.blocked.length} usable player${r.blocked.length===1?' is':'s are'} blocked.</strong> About ${r.leakage.toFixed(1)} expected points are sitting outside active slots.`;
  } else if (r.goalieUnconfirmed.length) {
    banner.className='action-banner warn';
    banner.innerHTML=`<strong>Skater lineup is clean.</strong> ${r.goalieUnconfirmed.length} goalie team game${r.goalieUnconfirmed.length===1?' needs':'s need'} a start probability before being counted.`;
  } else {
    banner.className='action-banner good';
    banner.innerHTML=`<strong>No obvious lineup waste.</strong> ${r.expectedStarts.toFixed(1)} expected usable start${r.expectedStarts===1?'':'s'} today.`;
  }
}

function renderWeek() {
  const w=projectWeek(state.roster,state.schedule,state.selectedDate,league.activeSlots);
  const wrap=$('#weekGrid');
  wrap.innerHTML='';
  for (const d of w.days) {
    const cls=d.nightClass==='light'?'light-night':d.nightClass==='medium'?'medium-night':d.nightClass==='heavy'?'heavy-night':'';
    const loaded=Object.prototype.hasOwnProperty.call(state.schedule,d.date);
    const scheduleText=loaded ? (d.games ? `${d.games} NHL games · ${d.nightClass} night` : '0 NHL games') : 'No schedule data';
    wrap.insertAdjacentHTML('beforeend',`<article class="day-card ${cls}"><div class="date">${esc(fmtDate(d.date))}</div><div class="tiny">${scheduleText}</div><div class="games">${d.expectedStarts.toFixed(1)}</div><div class="tiny">expected usable starts</div><div class="day-metrics"><div><span>Roster team games</span><strong>${d.scheduled.length}</strong></div><div><span>Blocked</span><strong>${d.blocked.length}</strong></div><div><span>Goalies TBD</span><strong>${d.goalieUnconfirmed.length}</strong></div><div><span>Proj. pts</span><strong>${d.points.toFixed(1)}</strong></div></div></article>`);
  }
}

function candidateAnalysisRows() {
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const rosterReady=rosterProjectionComplete();
  return state.waivers.map(c=>{
    const availability=playerAvailability(c,state.roster,state.leagueRosters);
    const available=['free-agent','waivers','available'].includes(availability.status);
    const analysis = available && hasProjection(c) && scheduleReady && rosterReady
      ? analyzeCandidate(c,state,league.activeSlots)
      : {...candidateScheduleMetrics(c,state.schedule,state.selectedDate),delta:Number.NaN,usableDelta:Number.NaN,drop:null,projectionMissing:!hasProjection(c),scheduleMissing:!scheduleReady,rosterProjectionMissing:!rosterReady};
    return {candidate:c,analysis,availability};
  }).sort((a,b)=>{
    const aReady=hasProjection(a.candidate), bReady=hasProjection(b.candidate);
    if (aReady !== bReady) return bReady-aReady;
    const ad=Number.isFinite(a.analysis.delta)?a.analysis.delta:-1e12;
    const bd=Number.isFinite(b.analysis.delta)?b.analysis.delta:-1e12;
    return bd-ad
      || (nullableNumber(b.candidate.yahooSeasonPoints) ?? -1e12) - (nullableNumber(a.candidate.yahooSeasonPoints) ?? -1e12)
      || b.analysis.light-a.analysis.light;
  });
}

function renderWaivers() {
  const body=$('#waiverTable');
  body.innerHTML='';
  const filter=String($('#waiverFilterInput')?.value || '').trim().toLowerCase();
  const posFilter=$('#waiverPositionFilter')?.value || '';
  const rows=candidateAnalysisRows().filter(({candidate:c,availability})=>{
    const text=`${c.name} ${c.team} ${(c.positions||[]).join(' ')} ${availability.status} ${availability.owner||''}`.toLowerCase();
    return (!filter || text.includes(filter)) && (!posFilter || (c.positions||[]).includes(posFilter));
  });
  $('#waiverPoolSummary').textContent = state.waivers.length
    ? `${rows.length} shown · ${state.waivers.length} in stored Yahoo/manual pool`
    : 'No Yahoo player pool loaded yet';
  if (!rows.length) {
    body.innerHTML='<tr><td colspan="13" class="muted">No waiver candidates match the current pool/filter.</td></tr>';
    return;
  }
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const rosterReady=rosterProjectionComplete();
  rows.forEach((x,i)=>{
    const c=x.candidate,a=x.analysis,availability=x.availability;
    const projectionReady=hasProjection(c);
    const available=['free-agent','waivers','available'].includes(availability.status);
    const actionable=available && scheduleReady && rosterReady && projectionReady && Number.isFinite(a.delta);
    const deltaText=actionable ? `${a.delta>=0?'+':''}${a.delta.toFixed(1)}` : '—';
    const gainCls=actionable && a.delta>=0?'gain-pos':'gain-neg';
    const buttonDisabled=!actionable || currentMovesUsed()>=league.maxAddsPerWeek;
    const buttonLabel=!available?'Verify availability':!scheduleReady?'Load schedule':!rosterReady?'Roster projections needed':!projectionReady?'Set projection':currentMovesUsed()>=league.maxAddsPerWeek?'Weekly limit reached':'Stage scenario';
    const owned=c.percentOwned==null?'—':`${c.percentOwned.toFixed(0)}%`;
    const dropText=!available
      ? '<span class="muted">Availability unverified</span>'
      : !scheduleReady
      ? '<span class="muted">Schedule needed</span>'
      : !rosterReady
        ? '<span class="muted">Roster projections needed</span>'
        : !projectionReady
          ? '<span class="muted">Projection needed</span>'
          : !actionable
            ? 'No legal drop'
            : a.drop?esc(a.drop.name):'<span class="gain-pos">Open slot</span>';
    body.insertAdjacentHTML('beforeend',`<tr>
      <td><span class="rank-badge">${i+1}</span></td>
      <td><div class="player-cell">${playerAvatar(c)}<div><strong>${esc(c.name)}</strong><div class="mini-note source-yahoo">${esc(c.team)} · ${esc(ownershipLabel(c))}</div></div></div></td>
      <td>${esc((c.positions||[]).join('/'))}</td>
      <td>${c.source==='manual' && availability.status!=='rostered'
        ? `<select class="w-availability" data-id="${esc(c.id)}" aria-label="Availability for ${esc(c.name)}"><option value="" ${availability.status==='unverified'?'selected':''}>Unverified</option><option value="freeagent" ${availability.status==='free-agent'?'selected':''}>Free agent</option><option value="waivers" ${availability.status==='waivers'?'selected':''}>Waivers</option></select>`
        : `<strong>${esc(availability.owner || (availability.status==='free-agent'?'Free agent':availability.status==='waivers'?'Waivers':availability.status==='available'?'Available · Yahoo':'Unverified'))}</strong>`}${c.source==='manual' && c.ownershipVerifiedAt ? `<div class="mini-note">${availability.status==='unverified'?'Yahoo check expired · verify again':`Checked ${esc(fmtWhen(c.ownershipVerifiedAt))} · valid 24h`}</div>` : ''}</td>
      <td>${statusBadge(c)}</td>
      <td>${owned}</td>
      <td><input class="w-fppg input-small" data-id="${esc(c.id)}" type="number" step="0.01" min="-20" max="30" value="${esc(projectionInputValue(c))}" /><div class="mini-note">${esc(projectionLabel(c))}</div></td>
      <td>${c.yahooSeasonPoints==null?'—':Number(c.yahooSeasonPoints).toFixed(1)}</td>
      <td>${a.games}</td>
      <td>${a.light}</td>
      <td>${dropText}</td>
      <td class="${gainCls}">${deltaText}${actionable?` <span class="mini-note">(${a.usableDelta>=0?'+':''}${a.usableDelta.toFixed(1)} starts)</span>`:''}</td>
      <td><button class="btn small-btn stage-waiver" data-id="${esc(c.id)}" ${buttonDisabled?'disabled':''}>${buttonLabel}</button></td>
    </tr>`);
  });
  body.querySelectorAll('.w-fppg').forEach(el=>el.addEventListener('change',e=>{
    const p=state.waivers.find(x=>x.id===e.target.dataset.id);
    if (!p) return;
    applyProjectionInput(p,e.target.value);
    saveState({source:'manual',action:'waiver-projection-edit',entityType:'player',entityId:p.yahooPlayerKey||p.id,after:{fppg:p.fppg,projectionSource:p.projectionSource}});renderAll();
  }));
  body.querySelectorAll('.w-availability').forEach(el=>el.addEventListener('change',e=>{
    const p=state.waivers.find(x=>x.id===e.target.dataset.id);
    if (!p) return;
    p.ownershipType=e.target.value || null;
    p.ownershipVerifiedAt=e.target.value ? new Date().toISOString() : null;
    saveState({source:'manual',action:'candidate-availability-confirm',entityType:'player',entityId:p.id,
      metadata:{name:p.name,availability:p.ownershipType}});
    renderAll();
  }));
  body.querySelectorAll('.stage-waiver').forEach(btn=>btn.addEventListener('click',()=>stageCandidate(btn.dataset.id)));
}

function stageCandidate(id) {
  if (currentMovesUsed()>=league.maxAddsPerWeek) {
    alert('The weekly acquisition limit is already reached. No scenario move will be staged.');
    return;
  }
  if (!hasScheduleWindow(state.schedule,state.selectedDate)) {
    alert('Load the NHL schedule for the selected 7-day window before evaluating a waiver move.');
    return;
  }
  if (!rosterProjectionComplete()) {
    alert('Complete projections for the active/bench roster before evaluating add/drop value. Unknown roster value is not treated as zero.');
    return;
  }
  const c=state.waivers.find(x=>x.id===id);
  if (!c) return;
  if (!['free-agent','waivers','available'].includes(playerAvailability(c,state.roster,state.leagueRosters).status)) {
    alert('Confirm this player is available in Yahoo before staging a scenario. Tracked league rosters may show a current owner.');
    return;
  }
  if (!hasProjection(c)) {
    alert('Set an FPPG projection for this player before staging an add/drop.');
    return;
  }
  const a=analyzeCandidate(c,state,league.activeSlots);
  if (!Number.isFinite(a.delta)) {
    alert('There is no legal stored-roster path for this player without dropping a protected/reserve player.');
    return;
  }
  const dropName=a.drop?.name || 'an open active/bench slot';
  const msg=`Stage ${c.name} in the stored scenario using ${dropName}${a.drop?' as the drop':''}?\n\nProjected 7-day change: ${a.delta>=0?'+':''}${a.delta.toFixed(1)} points.\n\nThis changes only the Situation Room scenario. It does NOT use a Yahoo acquisition or submit a transaction.`;
  if (!confirm(msg)) return;
  if (a.drop) state.roster=state.roster.filter(p=>p.id!==a.drop.id);
  state.roster.push({...c,id:makeUuid(),selectedPosition:'BN',source:'staged-scenario'});
  state.waivers=state.waivers.filter(x=>x.id!==id);
  saveState({source:'manual',action:'stage-candidate',entityType:'player',entityId:c.yahooPlayerKey||c.id,metadata:{candidate:c.name,drop:a.drop?.name||null,projectedDelta:a.delta}});renderAll();
}

function renderRoster() {
  const body=$('#rosterTable');
  body.innerHTML='';
  state.roster.forEach(p=>{
    const goalie=isGoalie(p);
    const yahoo=String(p.source||'').startsWith('yahoo');
    const locked=yahoo?'readonly':'';
    const owned=p.percentOwned==null?'—':`${p.percentOwned.toFixed(0)}%`;
    body.insertAdjacentHTML('beforeend',`<tr data-id="${esc(p.id)}">
      <td><div class="player-cell">${playerAvatar(p)}<div><input class="r-name" ${locked} value="${esc(p.name)}" /><div class="mini-note">${esc(p.source||'local')}</div></div></div></td>
      <td><input class="r-team input-tiny" ${locked} value="${esc(p.team)}" maxlength="4" /><input class="r-pos input-small" ${locked} value="${esc((p.positions||[]).join('/'))}" aria-label="Eligible positions for ${esc(p.name)}" /></td>
      <td><input class="r-selected input-tiny" ${locked} value="${esc(p.selectedPosition||'BN')}" /></td>
      <td><input class="r-status input-tiny" ${locked} value="${esc(p.status||'')}" placeholder="Active" /></td>
      <td><input class="r-fppg input-small" type="number" step="0.01" min="-20" max="30" value="${esc(projectionInputValue(p))}" /><div class="mini-note">${esc(projectionLabel(p))}</div></td>
      <td>${p.yahooSeasonPoints==null?'—':Number(p.yahooSeasonPoints).toFixed(1)}</td>
      <td>${p.referencePoints==null?'—':Number(p.referencePoints).toFixed(1)}${p.referencePoints==null?'':`<div class="mini-note">${esc(p.referenceLabel||'Reference')}</div>`}</td>
      <td>${owned}</td>
      <td>${goalie?`<input class="r-start input-small" type="number" step="5" min="0" max="100" value="${Math.round((Number(p.startProbability)||0)*100)}" />`:'<span class="mini-note">n/a</span>'}</td>
      <td class="checkbox-cell"><input class="r-core" type="checkbox" ${p.core?'checked':''} /></td>
      <td class="checkbox-cell"><input class="r-drop" type="checkbox" ${p.canDrop!==false?'checked':''} ${p.core||p.yahooUndroppable?'disabled':''} title="${p.yahooUndroppable?'Yahoo marks this player cant-cut':''}" />${p.yahooUndroppable?'<div class="mini-note">Yahoo cant-cut</div>':''}</td>
      <td><button class="btn small-btn remove-roster">Remove</button></td>
    </tr>`);
  });
  body.querySelectorAll('input').forEach(el=>el.addEventListener('change',handleRosterEdit));
  body.querySelectorAll('.remove-roster').forEach(btn=>btn.addEventListener('click',e=>{
    const id=e.target.closest('tr').dataset.id;
    const p=state.roster.find(x=>x.id===id);
    if (p && confirm(`Remove ${p.name} from the stored Situation Room model? This does not affect Yahoo.`)) {
      state.roster=state.roster.filter(x=>x.id!==id);saveState({source:'manual',action:'roster-remove',entityType:'player',entityId:p.yahooPlayerKey||p.id,before:p});renderAll();
    }
  }));
}

function handleRosterEdit(e) {
  const tr=e.target.closest('tr'), id=tr.dataset.id;
  const p=state.roster.find(x=>x.id===id);
  if (!p) return;
  const before=clone(p);
  p.name=tr.querySelector('.r-name').value.trim();
  p.team=tr.querySelector('.r-team').value.trim().toUpperCase();
  p.positions=parsePositions(tr.querySelector('.r-pos').value);
  p.selectedPosition=tr.querySelector('.r-selected').value.trim().toUpperCase() || 'BN';
  p.status=tr.querySelector('.r-status').value.trim().toUpperCase();
  if (e.target.classList.contains('r-fppg')) applyProjectionInput(p,tr.querySelector('.r-fppg').value);
  p.core=tr.querySelector('.r-core').checked;
  if (e.target.classList.contains('r-drop')) p.manualCanDrop=tr.querySelector('.r-drop').checked;
  p.canDrop=!p.core && p.manualCanDrop!==false && !p.yahooUndroppable;
  p.startProbability=isGoalie(p)?Math.max(0,Math.min(1,(Number(tr.querySelector('.r-start')?.value)||0)/100)):1;
  saveState({source:'manual',action:'roster-edit',entityType:'player',entityId:p.yahooPlayerKey||p.id,before,after:clone(p)});renderAll();
}

function renderLeague() {
  $('#slotChips').innerHTML=league.rosterSlots.map(x=>`<span class="chip">${x}</span>`).join('');
  $('#skaterScoring').innerHTML=Object.entries(league.skaterScoring).map(([k,v])=>`<div class="score-item"><span>${k}</span><strong>${v}</strong></div>`).join('');
  $('#goalieScoring').innerHTML=Object.entries(league.goalieScoring).map(([k,v])=>`<div class="score-item"><span>${k}</span><strong>${v}</strong></div>`).join('');
  $('#priorityLadder').innerHTML=league.priorityLadder.map(([n,name])=>`<div class="priority-item ${name===league.teamName?'mine':''}"><div class="priority-num">${n}</div><div><strong>${esc(name)}</strong>${name===league.teamName?'<div class="mini-note">You</div>':''}</div></div>`).join('');
  $('#movesUsedInput').value=currentMovesUsed();
}

function leagueRosterTeams() {
  const names=league.priorityLadder.map(([,name])=>name).filter(name=>name!==league.teamName);
  for (const entry of state.leagueRosters) if (!names.includes(entry.name)) names.push(entry.name);
  return names;
}

function renderLeagueRosters() {
  const select=$('#leagueRosterTeamSelect');
  const previous=select.value;
  const names=leagueRosterTeams();
  select.innerHTML=names.map(name=>{
    const entry=state.leagueRosters.find(team=>team.name===name);
    return `<option value="${esc(name)}">${esc(name)}${entry?` · ${entry.players.length} players`:''}</option>`;
  }).join('');
  if (names.includes(previous)) select.value=previous;
  const tracked=state.leagueRosters.filter(team=>team.players.length).length;
  const latest=state.yahoo.leagueRostersAt;
  $('#leagueRosterStatus').textContent=`${tracked} of ${league.teams-1} other teams have tracked rosters. ${latest?`Last Yahoo league sync: ${fmtWhen(latest)}. `:''}Players absent from tracked rosters remain unverified unless Yahoo or you confirm availability.`;
  const selected=state.leagueRosters.find(team=>team.name===select.value);
  const query=$('#leagueRosterSearch').value.trim().toLowerCase();
  const players=(selected?.players||[]).filter(p=>!query || `${p.name} ${p.team}`.toLowerCase().includes(query));
  $('#leagueRosterTable').innerHTML=players.length
    ? players.map(p=>`<tr><td><div class="player-cell">${playerAvatar(p)}<strong>${esc(p.name)}</strong></div></td><td>${esc(p.team)}</td><td>${esc(p.positions.join('/'))}</td><td>${esc(p.selectedPosition)}</td><td>${esc(selected.source)} · ${esc(fmtWhen(selected.updatedAt))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No tracked players for this team or filter.</td></tr>';
}

async function syncLeagueRosters() {
  const button=$('#syncLeagueRostersBtn');
  if (!yahooStatus.connected || !state.yahoo.leagueKey) {
    alert('Connect Yahoo and sync your team first. Yahoo must grant Fantasy API access before league rosters can load.');
    return;
  }
  button.disabled=true;
  button.textContent='Syncing…';
  try {
    const doc=await fetchXml(`/api/yahoo/league-teams?leagueKey=${encodeURIComponent(state.yahoo.leagueKey)}`);
    const teams=parseYahooTeams(doc).filter(team=>team.teamKey!==state.yahoo.teamKey);
    if (!teams.length) throw new Error('Yahoo returned no other league teams. Existing tracked rosters were kept.');
    const date=isoDate(new Date());
    const fetched=[];
    for (let i=0;i<teams.length;i+=3) {
      $('#leagueRosterStatus').textContent=`Loading league team rosters ${i+1}–${Math.min(i+3,teams.length)} of ${teams.length}…`;
      const batch=await Promise.all(teams.slice(i,i+3).map(async team=>{
        const rosterDoc=await fetchXml(`/api/yahoo/roster?teamKey=${encodeURIComponent(team.teamKey)}&date=${date}`);
        const players=parseYahooPlayers(rosterDoc,'yahoo-league-roster');
        if (!players.length) throw new Error(`Yahoo returned an empty roster for ${team.name}.`);
        return {teamKey:team.teamKey,name:team.name,source:'Yahoo Fantasy',updatedAt:new Date().toISOString(),players};
      }));
      fetched.push(...batch);
    }
    state.leagueRosters=fetched;
    state.yahoo.leagueRostersAt=new Date().toISOString();
    const saved=await saveState({source:'yahoo',action:'league-rosters-sync',metadata:{teamCount:fetched.length,playerCount:fetched.reduce((n,team)=>n+team.players.length,0),date}});
    renderAll();
    if (!saved) throw new Error(storageError || 'League rosters loaded but could not be saved.');
  } catch (err) {
    $('#leagueRosterStatus').textContent=`League roster sync failed: ${err.message}. Stored rosters were kept.`;
  } finally {
    button.disabled=false;
    button.textContent='Sync league rosters';
  }
}

function buildBrief() {
  const w=projectWeek(state.roster,state.schedule,state.selectedDate,league.activeSlots);
  const waiverRows=candidateAnalysisRows().filter(row=>['available','free-agent','waivers'].includes(row.availability.status)).slice(0,25);
  const projectionsReady=rosterProjectionComplete();
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const brief={
    purpose:'Analyze Dead Puck Society for daily lineup and waiver optimization. Maximize usable fantasy points, not raw roster value.',
    generatedAt:new Date().toISOString(),
    dataQuality:{scheduleWindowComplete:scheduleReady,rosterProjectionsComplete:projectionsReady,unknownProjectionMeans:null},
    dataSources:{roster:state.yahoo.rosterSource,yahooLastSync:state.yahoo.lastSyncAt,leagueRostersLastSync:state.yahoo.leagueRostersAt||null,nhlScheduleFetchedAt:state.scheduleFetchedAt},
    league:{yahooLeagueId:league.id,name:league.name,teams:league.teams,scoringType:league.scoringType,maxAddsPerWeek:league.maxAddsPerWeek,movesUsedThisWeek:currentMovesUsed(),movesWeekStart:mondayOf(isoDate(new Date())),waiverPriority:league.waiverPriority,waiverType:league.waiverType,lineupDeadline:league.lineupDeadline,activeSlots:league.activeSlots,skaterScoring:league.skaterScoring,goalieScoring:league.goalieScoring},
    roster:state.roster.map(p=>({name:p.name,team:p.team,positions:p.positions,yahooSlot:p.selectedPosition,status:p.status,fppg:hasProjection(p)?Number(p.fppg):null,core:p.core,manualCanDrop:p.manualCanDrop,canDrop:p.canDrop,yahooUndroppable:p.yahooUndroppable,startProbability:isGoalie(p)?p.startProbability:1,yahooSeasonPoints:p.yahooSeasonPoints,percentOwned:p.percentOwned,projectionSource:p.projectionSource,source:p.source})),
    otherTeams:state.leagueRosters.map(team=>({name:team.name,source:team.source,updatedAt:team.updatedAt,players:team.players.map(p=>({name:p.name,team:p.team,positions:p.positions,yahooSlot:p.selectedPosition}))})),
    next7Days:w.days.map(d=>({date:d.date,nhlGames:Object.prototype.hasOwnProperty.call(state.schedule,d.date)?d.games:null,night:Object.prototype.hasOwnProperty.call(state.schedule,d.date)?d.nightClass:null,rosterTeamGames:d.scheduled.map(p=>p.name),starters:d.starters.map(x=>({slot:league.activeSlots[x.slotIndex],player:x.player.name,availability:x.player.availability,projectionKnown:hasProjection(x.player)})),blocked:d.blocked.map(p=>p.name),goalieStartsUnconfirmed:d.goalieUnconfirmed.map(p=>p.name),projectedPoints:projectionsReady&&scheduleReady?Number(d.points.toFixed(2)):null})),
    summary:{expectedUsableStarts:scheduleReady?Number(w.usableGames.toFixed(2)):null,scheduledRosterTeamGames:scheduleReady?w.scheduledGames:null,projectedPoints:projectionsReady&&scheduleReady?Number(w.points.toFixed(2)):null,blockedProjectedPoints:projectionsReady&&scheduleReady?Number(w.leakage.toFixed(2)):null},
    waiverCandidates:waiverRows.map(({candidate:c,analysis:a})=>({name:c.name,team:c.team,positions:c.positions,fppg:hasProjection(c)?Number(c.fppg):null,yahooSeasonPoints:c.yahooSeasonPoints,percentOwned:c.percentOwned,ownershipType:c.ownershipType,projectionSource:c.projectionSource,games7d:a.games,lightNights:a.light,bestDrop:Number.isFinite(a.delta)?(a.drop?.name||'Open slot'):null,projectedNetGain:Number.isFinite(a.delta)?Number(a.delta.toFixed(2)):null,expectedStartsDelta:Number.isFinite(a.usableDelta)?Number(a.usableDelta.toFixed(2)):null})),
    instructions:['Treat null projections and null projected totals as unknown, not zero.','Only treat a player as available when Yahoo or the user has confirmed availability; absence from tracked team rosters is not proof.','Do not recommend dropping a core player or a player with canDrop=false.','Do not make add/drop value claims until rosterProjectionsComplete and scheduleWindowComplete are true.','Account for the 5-add weekly limit.','Prefer moves that create additional usable starts on light nights.','Goalie team games are not counted as starts when startProbability is 0.','FPPG is an editable estimate, not a guaranteed result.']
  };
  return 'DEAD PUCK SOCIETY — SITUATION BRIEF V2.2.1\n\n'+JSON.stringify(brief,null,2);
}

function exportState() {
  const payload={version:2,exportedAt:new Date().toISOString(),league,state};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`dead-puck-v2-backup-${isoDate(new Date())}.json`;a.click();URL.revokeObjectURL(a.href);
}

function importBackup(file) {
  if (file.size > 2 * 1024 * 1024) {
    alert('Backup is too large to import safely.');
    return;
  }
  const reader=new FileReader();
  reader.onload=async()=>{
    try {
      const payload=JSON.parse(reader.result);
      if (!payload.state || typeof payload.state !== 'object' || !Array.isArray(payload.state.roster)) {
        throw new Error('Not a Dead Puck backup.');
      }
      const incoming=normalizeState(payload.state);
      if (!confirm(`Replace the stored Situation Room state with this backup?\n\nRoster: ${incoming.roster.length}\nWaiver pool: ${incoming.waivers.length}\nSelected date: ${incoming.selectedDate}\n\nThis creates a new revision and does not affect Yahoo.`)) return;
      state=incoming;
      const saved=await saveState({source:'manual',action:'backup-import',metadata:{rosterCount:state.roster.length,waiverCount:state.waivers.length}});
      renderAll();
      if (!saved) alert('The backup is loaded in the recovery copy but could not be saved to Site storage. Use History / Storage to retry.');
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  };
  reader.onerror=()=>alert('Import failed: the backup file could not be read.');
  reader.readAsText(file);
}

function renderAll() {
  $('#todayDate').value=state.selectedDate;
  renderScheduleStatus();renderKPIs();renderToday();renderWeek();renderWaivers();renderRoster();renderLeague();renderLeagueRosters();renderSeasonReadiness();renderYahooStatus();renderPersistenceStatus();renderHistory();
}

function openTab(name) {
  const tab=$(`.tab[data-tab="${name}"]`);
  const panel=$(`#panel-${name}`);
  if (!tab || !panel) return;
  $$('.tab').forEach(x=>x.classList.remove('active'));
  $$('.tab-panel').forEach(x=>x.classList.remove('active'));
  tab.classList.add('active');
  panel.classList.add('active');
}

$$('.tab').forEach(btn=>btn.addEventListener('click',()=>openTab(btn.dataset.tab)));
$('#seasonReadiness').addEventListener('click',e=>{
  const button=e.target.closest('[data-open-tab]');
  if (button) openTab(button.dataset.openTab);
});
$('#todayDate').addEventListener('change',e=>{state.selectedDate=e.target.value||defaultPlannerDate();saveState({source:'manual',action:'planner-date-change',after:{selectedDate:state.selectedDate}});renderAll();});
$('#optimizeTodayBtn').addEventListener('click',renderToday);
$('#refreshScheduleBtn').addEventListener('click',refreshSchedule);
$('#connectYahooBtn').addEventListener('click',()=>{if(!yahooStatus.configured){alert('Yahoo integration is not configured yet.');return;}window.location.href='/api/yahoo/login';});
$('#syncYahooBtn').addEventListener('click',syncYahoo);
$('#syncYahooHeaderBtn').addEventListener('click',syncYahoo);
$('#searchYahooPlayersBtn').addEventListener('click',searchYahooPlayers);
$('#syncLeagueRostersBtn').addEventListener('click',syncLeagueRosters);
$('#leagueRosterTeamSelect').addEventListener('change',renderLeagueRosters);
$('#leagueRosterSearch').addEventListener('input',renderLeagueRosters);
let leagueRosterImportDraft=null;
$('#importLeagueRosterBtn').addEventListener('click',()=>{
  const name=$('#leagueRosterTeamSelect').value;
  const raw=$('#leagueRosterImport').value;
  const {players,errors}=parseRosterSnapshotLines(raw);
  if (!name || !players.length || errors.length) {
    alert(errors.length?`Invalid roster lines: ${errors.join(', ')}.`:'Choose a team and enter at least one valid player.');
    return;
  }
  leagueRosterImportDraft={name,raw,players};
  $('#leagueRosterImportReviewText').textContent=`Review: replace ${name}'s tracked roster with ${players.length} players. Yahoo will not change.`;
  $('#leagueRosterImportReview').hidden=false;
});
$('#confirmLeagueRosterImportBtn').addEventListener('click',()=>{
  const draft=leagueRosterImportDraft;
  if (!draft || draft.raw!==$('#leagueRosterImport').value || draft.name!==$('#leagueRosterTeamSelect').value) {
    $('#leagueRosterImportReviewText').textContent='The team or import text changed. Review the import again.';
    return;
  }
  state.leagueRosters=state.leagueRosters.filter(team=>team.name!==draft.name);
  state.leagueRosters.push({teamKey:null,name:draft.name,source:'Manual import',updatedAt:new Date().toISOString(),players:draft.players.map(normalizeLoadedPlayer)});
  saveState({source:'manual',action:'league-roster-import',entityType:'team',entityId:draft.name,metadata:{count:draft.players.length}});
  leagueRosterImportDraft=null;
  $('#leagueRosterImportReview').hidden=true;
  renderAll();
});
$('#cancelLeagueRosterImportBtn').addEventListener('click',()=>{leagueRosterImportDraft=null;$('#leagueRosterImportReview').hidden=true;});
$('#leagueRosterImport').addEventListener('input',()=>{leagueRosterImportDraft=null;$('#leagueRosterImportReview').hidden=true;});
$('#leagueRosterTeamSelect').addEventListener('change',()=>{leagueRosterImportDraft=null;$('#leagueRosterImportReview').hidden=true;});
$('#yahooPlayerSearch').addEventListener('keydown',e=>{if(e.key==='Enter')searchYahooPlayers();});
$('#waiverFilterInput').addEventListener('input',renderWaivers);
$('#waiverPositionFilter').addEventListener('change',renderWaivers);
$('#refreshHistoryBtn').addEventListener('click',loadHistory);
$('#retryStorageBtn').addEventListener('click',()=>{if(!pendingSaves.length){location.reload();return;}storageError='';storageConflict=false;drainSaveQueue();renderPersistenceStatus();});
$('#reloadSiteStateBtn').addEventListener('click',()=>{if(!confirm('Discard the browser recovery copy and reload the authoritative Site state? Export JSON first if you need to preserve the recovered view.'))return;localStorage.removeItem(PENDING_RECOVERY_KEY);location.reload();});
$('#disconnectYahooBtn').addEventListener('click',async()=>{if(!yahooStatus.connected)return;if(!confirm('Disconnect Yahoo from this Situation Room Site?'))return;await fetchJson('/api/yahoo/disconnect',{method:'POST'});state.yahoo={...clone(seedState.yahoo)};saveState({source:'yahoo',action:'yahoo-disconnect'});await loadYahooStatus();renderAll();});
$('#importWaiversBtn').addEventListener('click',()=>{const players=parsePlayerLines($('#waiverImport').value);if(!players.length){alert('No valid waiver lines found.');return;}state.waivers=players;saveState({source:'manual',action:'waiver-import',metadata:{count:players.length}});renderAll();});
$('#clearWaiversBtn').addEventListener('click',()=>{if(confirm('Clear the stored waiver candidate pool?')){const count=state.waivers.length;state.waivers=[];saveState({source:'manual',action:'waiver-clear',metadata:{count}});renderAll();}});
$('#addRosterRowBtn').addEventListener('click',()=>{const player=normalizeLoadedPlayer({id:makeUuid(),name:'New player',team:'',positions:['C'],fppg:0,core:false,canDrop:true,selectedPosition:'BN',source:'manual',projectionSource:'unset'});state.roster.push(player);saveState({source:'manual',action:'roster-add',entityType:'player',entityId:player.id,after:player});renderAll();});
let rosterImportDraft=null;
$('#importRosterBtn').addEventListener('click',()=>{
  const raw=$('#rosterImport').value;
  const {players,errors}=parseRosterSnapshotLines(raw);
  if (!players.length || errors.length) {alert(errors.length?`Invalid roster lines: ${errors.join(', ')}.`:'No valid roster lines found.');return;}
  if (players.length>22) {alert('This league has at most 22 roster slots, including reserve.');return;}
  rosterImportDraft={raw,players};
  $('#rosterImportReviewText').textContent=`Review: replace your stored roster with ${players.length} players. This does not change Yahoo.`;
  $('#rosterImportReview').hidden=false;
});
$('#confirmRosterImportBtn').addEventListener('click',()=>{
  const draft=rosterImportDraft;
  if (!draft || draft.raw!==$('#rosterImport').value) {
    $('#rosterImportReviewText').textContent='The import text changed. Review the import again.';
    return;
  }
  state.roster=draft.players.map(normalizeLoadedPlayer);
  state.yahoo.rosterSource='Manual screenshot import';
  saveState({source:'manual',action:'roster-import',metadata:{count:draft.players.length,source:'user-supplied roster screenshot'}});
  rosterImportDraft=null;
  $('#rosterImportReview').hidden=true;
  renderAll();
});
$('#cancelRosterImportBtn').addEventListener('click',()=>{rosterImportDraft=null;$('#rosterImportReview').hidden=true;});
$('#rosterImport').addEventListener('input',()=>{rosterImportDraft=null;$('#rosterImportReview').hidden=true;});
$('#movesUsedInput').addEventListener('change',e=>{const before=currentMovesUsed();state.movesThisWeek=Math.max(0,Math.min(league.maxAddsPerWeek,Number(e.target.value)||0));state.movesWeekStart=mondayOf(isoDate(new Date()));saveState({source:'manual',action:'moves-used-edit',before:{movesThisWeek:before},after:{movesThisWeek:state.movesThisWeek,weekStart:state.movesWeekStart}});renderAll();});
$('#copyBriefBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(buildBrief());$('#copyStatus').textContent='Situation Brief copied. Paste it into our ChatGPT conversation.';}catch{const ta=document.createElement('textarea');ta.value=buildBrief();document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();$('#copyStatus').textContent='Situation Brief copied.';}});
$('#exportBtn').addEventListener('click',exportState);
$('#importFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importBackup(f);e.target.value='';});
$('#resetBtn').addEventListener('click',()=>{if(confirm('Reset the stored Situation Room data to an empty seed? This will create a revision in history.')){const beforeSummary={rosterCount:state.roster.length,waiverCount:state.waivers.length,scheduleDays:Object.keys(state.schedule||{}).length};localStorage.removeItem(STORAGE_KEY);localStorage.removeItem(LEGACY_STORAGE_KEY);state=clone(seedState);saveState({source:'manual',action:'state-reset',metadata:{before:beforeSummary,after:{rosterCount:0,waiverCount:0,scheduleDays:0}}});renderAll();}});

try {
  await loadPersistedState();
} catch (err) {
  storageError=err.message || 'Site storage unavailable.';
  $('#saveStatus').textContent='Site storage unavailable';
  renderPersistenceStatus();
}
renderAll();
await Promise.all([loadYahooStatus(),loadHistory()]);
if (new URLSearchParams(window.location.search).get('yahoo')==='connected') {
  history.replaceState({},document.title,window.location.pathname);
  await loadYahooStatus();
}
