import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandidate, optimizeDay, parsePlayerLines, projectWeek } from '../public/logic.js';

const schedule={
  '2026-10-01':{games:5,teams:['AAA','BBB','CCC','DDD']},
  '2026-10-02':{games:12,teams:['AAA','BBB','EEE','FFF']},
  '2026-10-03':{games:4,teams:['AAA','CCC','EEE','GGG']},
  '2026-10-04':{games:8,teams:['BBB','CCC','DDD','EEE']},
  '2026-10-05':{games:6,teams:['AAA','DDD','FFF']},
  '2026-10-06':{games:11,teams:['BBB','EEE','GGG']},
  '2026-10-07':{games:3,teams:['AAA','CCC','GGG']}
};

function p(id,name,team,positions,fppg,extra={}) { return {id,name,team,positions,fppg,selectedPosition:'BN',status:'',...extra}; }

test('multi-position optimizer uses player in a legal slot',()=>{
  const roster=[p('1','Flex','AAA',['C','LW'],5),p('2','Center','BBB',['C'],4),p('3','Wing','CCC',['LW'],3)];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,3);
  assert.equal(r.points,12);
});

test('negative expected value player is not forced into lineup',()=>{
  const roster=[p('1','Bad','AAA',['C'],-2)];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,0);
  assert.equal(r.points,0);
});

test('injured goalie is unavailable, not mislabeled as an unconfirmed starter',()=>{
  const roster=[p('g','Injured Goalie','AAA',['G'],6,{status:'IR',startProbability:0})];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,0);
  assert.equal(r.goalieUnconfirmed.length,0);
  assert.equal(r.scheduled.length,0);
});

test('unconfirmed goalie team game is not counted as a goalie start',()=>{
  const roster=[p('g','Goalie','AAA',['G'],6,{startProbability:0})];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,0);
  assert.equal(r.goalieUnconfirmed.length,1);
});

test('confirmed goalie is weighted by start probability',()=>{
  const roster=[p('g','Goalie','AAA',['G'],6,{startProbability:.75})];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,1);
  assert.equal(r.points,4.5);
  assert.equal(r.expectedStarts,.75);
});

test('reserve player is excluded from lineup',()=>{
  const roster=[p('1','IR Guy','AAA',['C'],8,{selectedPosition:'IR'})];
  const r=optimizeDay(roster,schedule,'2026-10-01');
  assert.equal(r.starters.length,0);
});

test('candidate analysis uses an open active/bench slot before dropping anyone',()=>{
  const state={selectedDate:'2026-10-01',schedule,roster:[p('1','Core','AAA',['C'],4,{core:true,canDrop:false})]};
  const c=p('c','Candidate','BBB',['C'],5);
  const a=analyzeCandidate(c,state);
  assert.equal(a.drop,null);
  assert.ok(a.delta>=0);
});

test('parsePlayerLines makes goalies unconfirmed by default',()=>{
  const players=parsePlayerLines('Skater | AAA | C/RW | 4.2\nGoalie | BBB | G | 6.1');
  assert.equal(players.length,2);
  assert.equal(players[0].startProbability,1);
  assert.equal(players[1].startProbability,0);
  assert.equal(players[0].projectionSource,'manual');
  assert.equal(players[1].projectionSource,'manual');
});

test('week projection returns seven days',()=>{
  const w=projectWeek([p('1','A','AAA',['C'],4)],schedule,'2026-10-01');
  assert.equal(w.days.length,7);
  assert.ok(w.usableGames>0);
});
