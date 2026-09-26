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
  nightClass,
  optimizeDay,
  parsePlayerLines,
  parsePositions,
  projectWeek
} from './logic.js';

const STORAGE_KEY = 'deadPuckSituationRoom_v2';
const LEGACY_STORAGE_KEY = 'deadPuckSituationRoom_v1';
const PENDING_RECOVERY_KEY = 'deadPuckSituationRoom_pendingRecovery';

const league = {
  id: 46311,
  name: 'Blades of Glory Tokyo Drift',
  teamName: 'Dead Puck Society',
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

const seedState = {
  roster: [],
  waivers: [],
  movesThisWeek: 0,
  schedule: {},
  scheduleFetchedAt: null,
  selectedDate: isoDate(new Date()),
  yahoo: {
    teamKey: null,
    leagueKey: null,
    lastSyncAt: null,
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
  return p?.ownershipType || 'Available';
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
  return {
    id: p.id || makeUuid(),
    name: String(p.name || 'Unknown player'),
    team: String(p.team || '').toUpperCase(),
    positions,
    fppg: Number(p.fppg) || 0,
    core: Boolean(p.core),
    canDrop: p.canDrop !== false,
    selectedPosition: String(p.selectedPosition || 'BN'),
    status: String(p.status || ''),
    source: p.source || 'local',
    yahooPlayerKey: p.yahooPlayerKey || null,
    yahooSeasonPoints: nullableNumber(p.yahooSeasonPoints),
    ownershipType: p.ownershipType || null,
    percentOwned: nullableNumber(p.percentOwned),
    waiverDate: p.waiverDate || null,
    imageUrl: p.imageUrl || null,
    projectionSource: p.projectionSource || (p.source === 'manual' ? 'manual' : 'unset'),
    projectionUpdatedAt: p.projectionUpdatedAt || null,
    startProbability: goalie ? Math.max(0,Math.min(1,Number(p.startProbability)||0)) : 1,
    goalieStartProbabilities: p.goalieStartProbabilities || {}
  };
}

function migrateLegacy(legacy) {
  const migrated = clone(seedState);
  if (Array.isArray(legacy?.roster)) migrated.roster = legacy.roster.map(normalizeLoadedPlayer);
  if (Array.isArray(legacy?.waivers)) migrated.waivers = legacy.waivers.map(normalizeLoadedPlayer);
  if (legacy?.schedule && typeof legacy.schedule === 'object') migrated.schedule = legacy.schedule;
  if (legacy?.scheduleFetchedAt) migrated.scheduleFetchedAt = legacy.scheduleFetchedAt;
  if (legacy?.selectedDate) migrated.selectedDate = legacy.selectedDate;
  if (Number.isFinite(Number(legacy?.movesThisWeek))) migrated.movesThisWeek = Math.max(0,Math.min(league.maxAddsPerWeek,Number(legacy.movesThisWeek)));
  return migrated;
}

function normalizeState(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    ...clone(seedState),
    ...source,
    roster: Array.isArray(source.roster) ? source.roster.map(normalizeLoadedPlayer) : clone(seedState.roster),
    waivers: Array.isArray(source.waivers) ? source.waivers.map(normalizeLoadedPlayer) : [],
    yahoo: {...clone(seedState.yahoo), ...(source.yahoo || {})}
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
let yahooStatus = { configured:false, connected:false, writeEnabled:false, readOnlyDefault:true };
let storageError = '';
let storageConflict = false;

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
    metadata:entry.change.metadata,
    clientChangeId:entry.change.clientChangeId
  }));
  try {
    localStorage.setItem(PENDING_RECOVERY_KEY,JSON.stringify({
      version:2,
      state:latest.snapshot,
      baseRevision:stateRevision,
      pendingChanges,
      failedAt:failedAt || new Date().toISOString()
    }));
  } catch (err) {
    console.warn('Emergency recovery copy could not be written.',err);
  }
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

    if (!recovery?.state) return;

    if (Number(recovery.baseRevision) === stateRevision) {
      state=normalizeState(recovery.state);
      const pendingActions=Array.isArray(recovery.pendingChanges)
        ? recovery.pendingChanges.map(x=>x?.action).filter(Boolean)
        : [];
      const saved=await saveState({
        source:'system',
        action:'recovery-restore',
        metadata:{pendingActions,recoveredFrom:recovery.failedAt || null}
      });
      if (saved) localStorage.removeItem(PENDING_RECOVERY_KEY);
      return;
    }

    state=normalizeState(recovery.state);
    storageConflict=true;
    storageError='A browser recovery copy exists, but the Site has newer state. Export this recovered view if needed, then use “Reload Site state” to discard it.';
    $('#saveStatus').textContent='Recovery conflict · browser copy loaded';
    return;
  }

  if (recovery?.state) {
    state=normalizeState(recovery.state);
    const pendingActions=Array.isArray(recovery.pendingChanges)
      ? recovery.pendingChanges.map(x=>x?.action).filter(Boolean)
      : [];
    const saved=await saveState({
      source:'system',
      action:'recovery-restore',
      metadata:{pendingActions,recoveredFrom:recovery.failedAt || null}
    });
    if (!saved) throw new Error(storageError || 'Recovered Site state could not be saved.');
    localStorage.removeItem(PENDING_RECOVERY_KEY);
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
  const entry={
    snapshot:clone(state),
    change:{
      source:change.source || 'manual',
      action:change.action || 'state-update',
      entityType:change.entityType || null,
      entityId:change.entityId || null,
      before:change.before,
      after:change.after,
      metadata:change.metadata,
      clientChangeId:makeUuid()
    }
  };
  pendingSaves.push(entry);
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
        historyRows.unshift({
          id:result.changeId || entry.change.clientChangeId,
          revision:stateRevision,
          source:entry.change.source,
          action:entry.change.action,
          entityType:entry.change.entityType,
          entityId:entry.change.entityId,
          metadata:entry.change.metadata || null,
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
      canDrop: directText(el,'is_undroppable') !== '1',
      source,
      yahooSeasonPoints: Number.isFinite(seasonPoints) ? seasonPoints : null,
      ownershipType: ownershipEl ? directText(ownershipEl,'ownership_type') : null,
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

function mergeYahooRoster(yahooPlayers) {
  const oldByKey = new Map(state.roster.filter(p=>p.yahooPlayerKey).map(p=>[p.yahooPlayerKey,p]));
  const oldByName = new Map(state.roster.map(p=>[p.name.toLowerCase(),p]));
  return yahooPlayers.map(p=>{
    const old = oldByKey.get(p.yahooPlayerKey) || oldByName.get(p.name.toLowerCase());
    return normalizeLoadedPlayer({
      ...p,
      id: old?.id || p.id,
      fppg: Number(old?.fppg) || 0,
      projectionSource: old?.projectionSource || 'unset',
      projectionUpdatedAt: old?.projectionUpdatedAt || null,
      core: old?.core || false,
      canDrop: p.canDrop && (old ? old.canDrop !== false : true),
      startProbability: isGoalie(p) ? (Number(old?.startProbability)||0) : 1,
      goalieStartProbabilities: old?.goalieStartProbabilities || {}
    });
  });
}

function mergeYahooWaivers(yahooPlayers) {
  const oldByKey = new Map(state.waivers.filter(p=>p.yahooPlayerKey).map(p=>[p.yahooPlayerKey,p]));
  const oldByName = new Map(state.waivers.map(p=>[p.name.toLowerCase(),p]));
  return yahooPlayers.map(p=>{
    const old = oldByKey.get(p.yahooPlayerKey) || oldByName.get(p.name.toLowerCase());
    return normalizeLoadedPlayer({
      ...p,
      id: old?.id || p.id,
      fppg: Number(old?.fppg) || 0,
      projectionSource: old?.projectionSource || 'unset',
      projectionUpdatedAt: old?.projectionUpdatedAt || null,
      core:false,
      canDrop:true,
      startProbability: isGoalie(p) ? (Number(old?.startProbability)||0) : 1,
      goalieStartProbabilities: old?.goalieStartProbabilities || {}
    });
  });
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
    const data = await fetchJson('/api/changes?limit=100');
    historyRows = Array.isArray(data.changes) ? data.changes : [];
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
  $('#yahooRedirectUri').textContent = yahooStatus.redirectUri || 'Will be assigned when Yahoo OAuth is added to the Site';
  $('#yahooMissingConfig').textContent = yahooStatus.configured ? 'Configured' : 'Yahoo app setup is the next phase';
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
    state.yahoo.teamKey = team.teamKey;
    state.yahoo.leagueKey = leagueKey;

    const rosterDate = isoDate(new Date());
    log.textContent = `Syncing current roster for ${rosterDate}…`;
    const rosterDoc = await fetchXml(`/api/yahoo/roster?teamKey=${encodeURIComponent(team.teamKey)}&date=${encodeURIComponent(rosterDate)}`);
    const rosterPlayers = parseYahooPlayers(rosterDoc,'yahoo-roster');
    if (!rosterPlayers.length) throw new Error('Yahoo roster response contained no players.');
    state.roster = mergeYahooRoster(rosterPlayers);

    log.textContent = 'Loading available players…';
    const [availableDoc0, availableDoc50] = await Promise.all([
      fetchXml(`/api/yahoo/available?leagueKey=${encodeURIComponent(leagueKey)}&status=A&start=0&count=50`),
      fetchXml(`/api/yahoo/available?leagueKey=${encodeURIComponent(leagueKey)}&status=A&start=50&count=50`)
    ]);
    const available = [...parseYahooPlayers(availableDoc0,'yahoo-available'), ...parseYahooPlayers(availableDoc50,'yahoo-available')];
    const seen = new Set();
    state.waivers = mergeYahooWaivers(available.filter(p=>p.yahooPlayerKey && !seen.has(p.yahooPlayerKey) && seen.add(p.yahooPlayerKey)));

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
    const incoming = mergeYahooWaivers(parseYahooPlayers(doc,'yahoo-search'));
    const manual = state.waivers.filter(p=>!p.yahooPlayerKey);
    const byKey = new Map(state.waivers.filter(p=>p.yahooPlayerKey).map(p=>[p.yahooPlayerKey,p]));
    for (const p of incoming) byKey.set(p.yahooPlayerKey,p);
    state.waivers = [...manual, ...byKey.values()];
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

function renderKPIs() {
  const w = projectWeek(state.roster,state.schedule,state.selectedDate,league.activeSlots);
  const counts = rosterCounts();
  $('#kpiMoves').textContent = `${Math.max(0,league.maxAddsPerWeek-state.movesThisWeek)} / ${league.maxAddsPerWeek}`;
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
    const analysis = hasProjection(c) && scheduleReady && rosterReady
      ? analyzeCandidate(c,state,league.activeSlots)
      : {...candidateScheduleMetrics(c,state.schedule,state.selectedDate),delta:Number.NaN,usableDelta:Number.NaN,drop:null,projectionMissing:!hasProjection(c),scheduleMissing:!scheduleReady,rosterProjectionMissing:!rosterReady};
    return {candidate:c,analysis};
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
  const rows=candidateAnalysisRows().filter(({candidate:c})=>{
    const text=`${c.name} ${c.team} ${(c.positions||[]).join(' ')} ${ownershipLabel(c)}`.toLowerCase();
    return (!filter || text.includes(filter)) && (!posFilter || (c.positions||[]).includes(posFilter));
  });
  $('#waiverPoolSummary').textContent = state.waivers.length
    ? `${rows.length} shown · ${state.waivers.length} in stored Yahoo/manual pool`
    : 'No Yahoo player pool loaded yet';
  if (!rows.length) {
    body.innerHTML='<tr><td colspan="12" class="muted">No waiver candidates match the current pool/filter.</td></tr>';
    return;
  }
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const rosterReady=rosterProjectionComplete();
  rows.forEach((x,i)=>{
    const c=x.candidate,a=x.analysis;
    const projectionReady=hasProjection(c);
    const actionable=scheduleReady && rosterReady && projectionReady && Number.isFinite(a.delta);
    const deltaText=actionable ? `${a.delta>=0?'+':''}${a.delta.toFixed(1)}` : '—';
    const gainCls=actionable && a.delta>=0?'gain-pos':'gain-neg';
    const buttonDisabled=!actionable || state.movesThisWeek>=league.maxAddsPerWeek;
    const buttonLabel=!scheduleReady?'Load schedule':!rosterReady?'Roster projections needed':!projectionReady?'Set projection':state.movesThisWeek>=league.maxAddsPerWeek?'Weekly limit reached':'Stage scenario';
    const owned=c.percentOwned==null?'—':`${c.percentOwned.toFixed(0)}%`;
    const dropText=!scheduleReady
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
  body.querySelectorAll('.stage-waiver').forEach(btn=>btn.addEventListener('click',()=>stageCandidate(btn.dataset.id)));
}

function stageCandidate(id) {
  if (state.movesThisWeek>=league.maxAddsPerWeek) {
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
      <td><input class="r-team input-tiny" ${locked} value="${esc(p.team)}" maxlength="4" /><div class="mini-note">${esc((p.positions||[]).join('/'))}</div><input class="r-pos visually-hidden" ${locked} value="${esc((p.positions||[]).join('/'))}" /></td>
      <td><input class="r-selected input-tiny" ${locked} value="${esc(p.selectedPosition||'BN')}" /></td>
      <td><input class="r-status input-tiny" ${locked} value="${esc(p.status||'')}" placeholder="Active" /></td>
      <td><input class="r-fppg input-small" type="number" step="0.01" min="-20" max="30" value="${esc(projectionInputValue(p))}" /><div class="mini-note">${esc(projectionLabel(p))}</div></td>
      <td>${p.yahooSeasonPoints==null?'—':Number(p.yahooSeasonPoints).toFixed(1)}</td>
      <td>${owned}</td>
      <td>${goalie?`<input class="r-start input-small" type="number" step="5" min="0" max="100" value="${Math.round((Number(p.startProbability)||0)*100)}" />`:'<span class="mini-note">n/a</span>'}</td>
      <td class="checkbox-cell"><input class="r-core" type="checkbox" ${p.core?'checked':''} /></td>
      <td class="checkbox-cell"><input class="r-drop" type="checkbox" ${p.canDrop!==false?'checked':''} ${p.core?'disabled':''} /></td>
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
  p.canDrop=p.core?false:tr.querySelector('.r-drop').checked;
  p.startProbability=isGoalie(p)?Math.max(0,Math.min(1,(Number(tr.querySelector('.r-start')?.value)||0)/100)):1;
  saveState({source:'manual',action:'roster-edit',entityType:'player',entityId:p.yahooPlayerKey||p.id,before,after:clone(p)});renderAll();
}

function renderLeague() {
  $('#slotChips').innerHTML=league.rosterSlots.map(x=>`<span class="chip">${x}</span>`).join('');
  $('#skaterScoring').innerHTML=Object.entries(league.skaterScoring).map(([k,v])=>`<div class="score-item"><span>${k}</span><strong>${v}</strong></div>`).join('');
  $('#goalieScoring').innerHTML=Object.entries(league.goalieScoring).map(([k,v])=>`<div class="score-item"><span>${k}</span><strong>${v}</strong></div>`).join('');
  $('#priorityLadder').innerHTML=league.priorityLadder.map(([n,name])=>`<div class="priority-item ${name===league.teamName?'mine':''}"><div class="priority-num">${n}</div><div><strong>${esc(name)}</strong>${name===league.teamName?'<div class="mini-note">You</div>':''}</div></div>`).join('');
  $('#movesUsedInput').value=state.movesThisWeek;
}

function buildBrief() {
  const w=projectWeek(state.roster,state.schedule,state.selectedDate,league.activeSlots);
  const waiverRows=candidateAnalysisRows().slice(0,25);
  const projectionsReady=rosterProjectionComplete();
  const scheduleReady=hasScheduleWindow(state.schedule,state.selectedDate);
  const brief={
    purpose:'Analyze Dead Puck Society for daily lineup and waiver optimization. Maximize usable fantasy points, not raw roster value.',
    generatedAt:new Date().toISOString(),
    dataQuality:{scheduleWindowComplete:scheduleReady,rosterProjectionsComplete:projectionsReady,unknownProjectionMeans:null},
    dataSources:{roster:state.yahoo.rosterSource,yahooLastSync:state.yahoo.lastSyncAt,nhlScheduleFetchedAt:state.scheduleFetchedAt},
    league:{yahooLeagueId:league.id,name:league.name,teams:league.teams,scoringType:league.scoringType,maxAddsPerWeek:league.maxAddsPerWeek,movesUsedThisWeek:state.movesThisWeek,waiverPriority:league.waiverPriority,waiverType:league.waiverType,lineupDeadline:league.lineupDeadline,activeSlots:league.activeSlots,skaterScoring:league.skaterScoring,goalieScoring:league.goalieScoring},
    roster:state.roster.map(p=>({name:p.name,team:p.team,positions:p.positions,yahooSlot:p.selectedPosition,status:p.status,fppg:hasProjection(p)?Number(p.fppg):null,core:p.core,canDrop:p.canDrop,startProbability:isGoalie(p)?p.startProbability:1,yahooSeasonPoints:p.yahooSeasonPoints,percentOwned:p.percentOwned,projectionSource:p.projectionSource,source:p.source})),
    next7Days:w.days.map(d=>({date:d.date,nhlGames:Object.prototype.hasOwnProperty.call(state.schedule,d.date)?d.games:null,night:Object.prototype.hasOwnProperty.call(state.schedule,d.date)?d.nightClass:null,rosterTeamGames:d.scheduled.map(p=>p.name),starters:d.starters.map(x=>({slot:league.activeSlots[x.slotIndex],player:x.player.name,availability:x.player.availability,projectionKnown:hasProjection(x.player)})),blocked:d.blocked.map(p=>p.name),goalieStartsUnconfirmed:d.goalieUnconfirmed.map(p=>p.name),projectedPoints:projectionsReady&&scheduleReady?Number(d.points.toFixed(2)):null})),
    summary:{expectedUsableStarts:scheduleReady?Number(w.usableGames.toFixed(2)):null,scheduledRosterTeamGames:scheduleReady?w.scheduledGames:null,projectedPoints:projectionsReady&&scheduleReady?Number(w.points.toFixed(2)):null,blockedProjectedPoints:projectionsReady&&scheduleReady?Number(w.leakage.toFixed(2)):null},
    waiverCandidates:waiverRows.map(({candidate:c,analysis:a})=>({name:c.name,team:c.team,positions:c.positions,fppg:hasProjection(c)?Number(c.fppg):null,yahooSeasonPoints:c.yahooSeasonPoints,percentOwned:c.percentOwned,ownershipType:c.ownershipType,projectionSource:c.projectionSource,games7d:a.games,lightNights:a.light,bestDrop:Number.isFinite(a.delta)?(a.drop?.name||'Open slot'):null,projectedNetGain:Number.isFinite(a.delta)?Number(a.delta.toFixed(2)):null,expectedStartsDelta:Number.isFinite(a.usableDelta)?Number(a.usableDelta.toFixed(2)):null})),
    instructions:['Treat null projections and null projected totals as unknown, not zero.','Do not assume a player is available unless listed in waiverCandidates.','Do not recommend dropping a core player or a player with canDrop=false.','Do not make add/drop value claims until rosterProjectionsComplete and scheduleWindowComplete are true.','Account for the 5-add weekly limit.','Prefer moves that create additional usable starts on light nights.','Goalie team games are not counted as starts when startProbability is 0.','FPPG is an editable estimate, not a guaranteed result.']
  };
  return 'DEAD PUCK SOCIETY — SITUATION BRIEF V2.2.1\n\n'+JSON.stringify(brief,null,2);
}

function exportState() {
  const payload={version:2,exportedAt:new Date().toISOString(),league,state};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`dead-puck-v2-backup-${isoDate(new Date())}.json`;a.click();URL.revokeObjectURL(a.href);
}

function importBackup(file) {
  const reader=new FileReader();
  reader.onload=()=>{
    try {
      const payload=JSON.parse(reader.result);
      if (!payload.state || !Array.isArray(payload.state.roster)) throw new Error('Not a Dead Puck backup.');
      state={...clone(seedState),...payload.state,roster:payload.state.roster.map(normalizeLoadedPlayer),waivers:(payload.state.waivers||[]).map(normalizeLoadedPlayer),yahoo:{...clone(seedState.yahoo),...(payload.state.yahoo||{})}};
      saveState({source:'manual',action:'backup-import',metadata:{rosterCount:state.roster.length,waiverCount:state.waivers.length}});renderAll();
    } catch (err) { alert(`Import failed: ${err.message}`); }
  };
  reader.readAsText(file);
}

function renderAll() {
  $('#todayDate').value=state.selectedDate;
  renderScheduleStatus();renderKPIs();renderToday();renderWeek();renderWaivers();renderRoster();renderLeague();renderYahooStatus();renderPersistenceStatus();renderHistory();
}

$$('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  $$('.tab').forEach(x=>x.classList.remove('active'));$$('.tab-panel').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#panel-'+btn.dataset.tab).classList.add('active');
}));
$('#todayDate').addEventListener('change',e=>{state.selectedDate=e.target.value||isoDate(new Date());saveState({source:'manual',action:'planner-date-change',after:{selectedDate:state.selectedDate}});renderAll();});
$('#optimizeTodayBtn').addEventListener('click',renderToday);
$('#refreshScheduleBtn').addEventListener('click',refreshSchedule);
$('#connectYahooBtn').addEventListener('click',()=>{if(!yahooStatus.configured){alert('Yahoo integration is not configured yet.');return;}window.location.href='/api/yahoo/login';});
$('#syncYahooBtn').addEventListener('click',syncYahoo);
$('#syncYahooHeaderBtn').addEventListener('click',syncYahoo);
$('#searchYahooPlayersBtn').addEventListener('click',searchYahooPlayers);
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
$('#importRosterBtn').addEventListener('click',()=>{const players=parsePlayerLines($('#rosterImport').value);if(!players.length){alert('No valid roster lines found.');return;}if(!confirm(`Replace the stored roster with ${players.length} imported players?`))return;state.roster=players.map(normalizeLoadedPlayer);state.yahoo.rosterSource='Manual import';saveState({source:'manual',action:'roster-import',metadata:{count:players.length}});renderAll();});
$('#movesUsedInput').addEventListener('change',e=>{const before=state.movesThisWeek;state.movesThisWeek=Math.max(0,Math.min(league.maxAddsPerWeek,Number(e.target.value)||0));saveState({source:'manual',action:'moves-used-edit',before:{movesThisWeek:before},after:{movesThisWeek:state.movesThisWeek}});renderAll();});
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
