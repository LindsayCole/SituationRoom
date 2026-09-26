export const ACTIVE_SLOTS = ["C","C","LW","LW","RW","RW","D","D","D","D","UTIL","UTIL","G","G"];
export const ACTIVE_BENCH_CAPACITY = 18;

export function makeUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `dps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function isoDate(d) {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr,n) {
  const d=new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate()+n);
  return isoDate(d);
}

export function parsePositions(s) {
  return [...new Set(String(s||"").toUpperCase().split(/[\/,\s]+/).map(x=>x.trim()).filter(x=>["C","LW","RW","D","G"].includes(x)))];
}

export function isGoalie(player) {
  return (player.positions || []).map(String).map(x=>x.toUpperCase()).includes('G');
}

export function hasProjectionValue(player) {
  if (String(player?.projectionSource || '').toLowerCase() === 'unset') return false;
  return Number.isFinite(Number(player?.fppg));
}

export function isReserve(player) {
  return ['IR','IR+'].includes(String(player.selectedPosition || '').toUpperCase());
}

export function isUnavailable(player) {
  if (isReserve(player)) return true;
  const status = String(player.status || '').toUpperCase();
  return ['IR','IR+','NA','O'].includes(status);
}

export function dayAvailability(player, date) {
  if (isUnavailable(player)) return 0;
  if (!isGoalie(player)) return 1;
  const specific = player.goalieStartProbabilities?.[date];
  const fallback = player.startProbability;
  const value = specific ?? fallback ?? 0;
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function playingTeams(schedule, date) {
  return new Set((schedule?.[date]?.teams || []).map(x=>String(x).toUpperCase()));
}

export function playerHasTeamGame(player, schedule, date) {
  return playingTeams(schedule, date).has(String(player.team || '').toUpperCase());
}

export function gamesOn(schedule, date) {
  return Number(schedule?.[date]?.games || 0);
}

export function hasScheduleWindow(schedule, start, days=7) {
  if (!start || !schedule || typeof schedule !== 'object') return false;
  for (let i=0;i<days;i++) {
    if (!Object.prototype.hasOwnProperty.call(schedule, addDays(start,i))) return false;
  }
  return true;
}

export function nightClass(gameCount) {
  if (gameCount <= 0) return 'none';
  if (gameCount <= 6) return 'light';
  if (gameCount <= 10) return 'medium';
  return 'heavy';
}

export function eligibleSlotIndexes(player, activeSlots=ACTIVE_SLOTS) {
  const set=new Set((player.positions||[]).map(x=>String(x).toUpperCase()));
  const out=[];
  activeSlots.forEach((slot,i)=>{
    if(slot==='UTIL') {
      if([...set].some(p=>['C','LW','RW','D'].includes(p))) out.push(i);
    } else if(set.has(slot)) out.push(i);
  });
  return out;
}

export function optimizeDay(roster, schedule, date, activeSlots=ACTIVE_SLOTS) {
  const teamGamePlayers=(roster||[]).filter(p=>playerHasTeamGame(p,schedule,date));
  const scheduled=teamGamePlayers.filter(p=>!isUnavailable(p));
  const goalieUnconfirmed=scheduled.filter(p=>isGoalie(p) && dayAvailability(p,date)<=0);
  const playing=scheduled
    .map(p=>({...p,availability:dayAvailability(p,date),fppg:Number(p.fppg)||0}))
    .filter(p=>p.availability>0);

  let dp=new Map([[0,{points:0,assign:[]}]]);
  for(const player of playing) {
    const next=new Map(dp);
    for(const [mask,rec] of dp.entries()) {
      for(const slotIndex of eligibleSlotIndexes(player,activeSlots)) {
        const bit=1<<slotIndex;
        if(mask & bit) continue;
        const newMask=mask|bit;
        const points=rec.points+(player.fppg*player.availability);
        const prev=next.get(newMask);
        if(!prev || points>prev.points || (points===prev.points && rec.assign.length+1>prev.assign.length)) {
          next.set(newMask,{points,assign:[...rec.assign,{slotIndex,player}]});
        }
      }
    }
    dp=next;
  }

  let best={points:0,assign:[]};
  for(const rec of dp.values()) {
    if(rec.points>best.points || (rec.points===best.points && rec.assign.length>best.assign.length)) best=rec;
  }
  const starterIds=new Set(best.assign.map(x=>x.player.id));
  const blocked=playing.filter(p=>!starterIds.has(p.id));
  const expectedStarts=best.assign.reduce((s,x)=>s+x.player.availability,0);
  return {
    starters:best.assign.sort((a,b)=>a.slotIndex-b.slotIndex),
    blocked,
    scheduled,
    eligiblePlaying:playing,
    goalieUnconfirmed,
    points:best.points,
    expectedStarts,
    leakage:blocked.reduce((s,p)=>s+Math.max(0,p.fppg*p.availability),0)
  };
}

export function projectWeek(roster, schedule, start, activeSlots=ACTIVE_SLOTS) {
  let usableGames=0, points=0, leakage=0, scheduledGames=0;
  const days=[];
  for(let i=0;i<7;i++) {
    const date=addDays(start,i);
    const r=optimizeDay(roster,schedule,date,activeSlots);
    usableGames+=r.expectedStarts;
    scheduledGames+=r.scheduled.length;
    points+=r.points;
    leakage+=r.leakage;
    days.push({date,...r,games:gamesOn(schedule,date),nightClass:nightClass(gamesOn(schedule,date))});
  }
  return {usableGames,scheduledGames,points,leakage,days};
}

export function candidateScheduleMetrics(candidate, schedule, start) {
  let games=0,light=0;
  for(let i=0;i<7;i++) {
    const date=addDays(start,i);
    if(playerHasTeamGame(candidate,schedule,date)) {
      games++;
      if(nightClass(gamesOn(schedule,date))==='light') light++;
    }
  }
  return {games,light};
}

export function analyzeCandidate(candidate, state, activeSlots=ACTIVE_SLOTS) {
  const scheduleMetrics=candidateScheduleMetrics(candidate,state.schedule,state.selectedDate);
  if(!hasProjectionValue(candidate)) {
    return {drop:null,delta:Number.NaN,usableDelta:Number.NaN,notActionable:true,projectionMissing:true,...scheduleMetrics};
  }

  const activeBench=(state.roster||[]).filter(p=>!isReserve(p));
  const missingRosterProjections=activeBench.filter(p=>!hasProjectionValue(p));
  if(missingRosterProjections.length) {
    return {
      drop:null,
      delta:Number.NaN,
      usableDelta:Number.NaN,
      notActionable:true,
      rosterProjectionMissing:true,
      missingRosterProjectionIds:missingRosterProjections.map(p=>p.id),
      ...scheduleMetrics
    };
  }

  const base=projectWeek(state.roster,state.schedule,state.selectedDate,activeSlots);
  const activeBenchCount=activeBench.length;
  const possibleDrops=activeBench.filter(p=>p.canDrop!==false && !p.core);
  const trials=[];

  if(activeBenchCount < ACTIVE_BENCH_CAPACITY) {
    const roster=[...state.roster,{...candidate,id:candidate.id||makeUuid()}];
    const p=projectWeek(roster,state.schedule,state.selectedDate,activeSlots);
    trials.push({drop:null,delta:p.points-base.points,usableDelta:p.usableGames-base.usableGames});
  }
  for(const drop of possibleDrops) {
    const roster=state.roster.filter(p=>p.id!==drop.id).concat([{...candidate,id:candidate.id||makeUuid()}]);
    const p=projectWeek(roster,state.schedule,state.selectedDate,activeSlots);
    trials.push({drop,delta:p.points-base.points,usableDelta:p.usableGames-base.usableGames});
  }
  trials.sort((a,b)=>b.delta-a.delta || b.usableDelta-a.usableDelta);
  const best=trials[0] || {drop:null,delta:Number.NEGATIVE_INFINITY,usableDelta:0,notActionable:true};
  return {...best,...scheduleMetrics};
}

export function parsePlayerLines(text) {
  const out=[];
  for(const raw of String(text||'').split(/\r?\n/)) {
    const line=raw.trim();
    if(!line) continue;
    const parts=line.includes('|') ? line.split('|') : line.split(',');
    if(parts.length<3) continue;
    const [name,team,pos,fppgRaw='']=parts.map(x=>x.trim());
    const positions=parsePositions(pos);
    if(!name || !team || !positions.length) continue;
    const goalie=positions.includes('G');
    const hasManualProjection=fppgRaw !== '' && Number.isFinite(Number(fppgRaw));
    out.push({
      id:makeUuid(),name,team:team.toUpperCase(),positions,
      fppg:hasManualProjection ? Number(fppgRaw) : 0,core:false,canDrop:true,
      selectedPosition:'BN',status:'',source:'manual',
      projectionSource:hasManualProjection ? 'manual' : 'unset',
      projectionUpdatedAt:hasManualProjection ? new Date().toISOString() : null,
      startProbability:goalie ? 0 : 1
    });
  }
  return out;
}
