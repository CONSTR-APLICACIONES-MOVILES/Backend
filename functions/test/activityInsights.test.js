const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCreationInsight,buildConfirmationInsight,rankWithHistory,confirmationAttribution} = require('../src/activityInsights');
const now=new Date('2026-10-30T15:00:00Z'), DAY=86400000;
const exposed=new Date(+now-2*DAY), selected=new Date(+exposed+60000);
const candidate=(id,extra={})=>({id,activityId:'activity',batchId:'batch',schemaVersion:2,groupSize:3,category:'study',
  startTime:'2026-10-28T16:00:00Z',endTime:'2026-10-28T17:00:00Z',presentedAt:exposed,
  batchPresentedAt:exposed,decidedAt:selected,outcome:'NOT_SELECTED',environment:'production',...extra});

test('BQ2 ten attempts, two failures and one actual timeout -> 30%, including unresolved',()=>{
  const rows=Array.from({length:10},(_,i)=>({uid:'u',attemptId:`a${i}`,requestId:i<2?'same':`r${i}`,startedAt:exposed,
    environment:'production',outcome:i<2?'failure':i===2?'timeout':i===9?null:'success',durationMs:i===2?8000:9000}));
  rows.push({...rows[0]}, {...rows[1],attemptId:'test',environment:'test'});
  const insight=buildCreationInsight(rows,now);
  assert.equal(insight.attempts,10); assert.equal(insight.failure_or_timeout_pct,30);
  assert.equal(insight.unresolved,1); assert.equal(insight.coverage_pct,90);
  assert.equal(insight.timeout,1,'a slow success is not a timeout');
  assert.equal(insight.logical_publications,9); assert.equal(insight.p95_duration_ms,9000);
  assert.equal(buildCreationInsight([],now).failure_or_timeout_pct,null);
});
test('BQ2 reconciliation never erases observed timeout and uploaded starts stay in denominator',()=>{
  const rows=[{uid:'u',attemptId:'a',requestId:'r',startedAt:exposed,environment:'production',outcome:'timeout',remoteOutcome:'success'},
    {uid:'u',attemptId:'b',requestId:'r',startedAt:exposed,environment:'production'}];
  const r=buildCreationInsight(rows,now); assert.equal(r.timeout,1); assert.equal(r.reconciled_success,1);
  assert.equal(r.unresolved,1); assert.equal(r.failure_or_timeout_pct,50);
});
test('BQ13 counts only the selected unchanged candidate at first confirmation, never whole batch',()=>{
  const a=candidate('a',{outcome:'ACCEPTED_UNCHANGED'}), b=candidate('b'), c=candidate('c');
  const measurements=new Map([['activity',{firstConfirmedAt:new Date(+exposed+3600000),
    confirmationRecommendation:{candidateId:'a',batchId:'batch',startTime:a.startTime,endTime:a.endTime}}]]);
  const r=buildConfirmationInsight([a,b,c,a],measurements,now);
  assert.equal(r.opportunities,3); assert.equal(r.confirmed,1); assert.equal(r.confirmation_rate,33.33);
});
test('BQ13 accepted without confirmation, modified, immature and unknown do not invent success',()=>{
  const rows=[candidate('a',{outcome:'ACCEPTED_UNCHANGED'}),candidate('b',{outcome:'MODIFIED'}),
    candidate('c',{activityId:'young',batchId:'young',presentedAt:now,batchPresentedAt:now}),
    candidate('d',{schemaVersion:1}),candidate('test',{environment:'test'})];
  const r=buildConfirmationInsight(rows,new Map([['activity',{firstConfirmedAt:null}]]),now);
  assert.equal(r.confirmed,0); assert.equal(r.mature_opportunities,2); assert.equal(r.pending,1); assert.equal(r.unknown,1);
  assert.equal(buildConfirmationInsight([],new Map(),now).confirmation_rate,null);
});
test('BQ13 missing historical confirmation attribution is unknown, not a zero conversion',()=>{
  const a=candidate('a',{outcome:'ACCEPTED_UNCHANGED'});
  const r=buildConfirmationInsight([a],new Map([['activity',{firstConfirmedAt:new Date(+selected+1000)}]]),now);
  assert.equal(r.unknown,1);assert.equal(r.mature_opportunities,0);assert.equal(r.confirmation_rate,null);
});
test('BQ13 rejects confirmation before selection, after 24h, wrong batch or changed interval',()=>{
  const a=candidate('a',{outcome:'ACCEPTED_UNCHANGED'});
  for(const change of [{firstConfirmedAt:new Date(+selected-1)},{firstConfirmedAt:new Date(+exposed+DAY+1)},
    {batchId:'wrong'},{startTime:'2026-10-28T18:00:00Z'}]) {
    const measurement={firstConfirmedAt:new Date(+selected+1000),confirmationRecommendation:{candidateId:'a',batchId:'batch',startTime:a.startTime,endTime:a.endTime,...change},...change};
    const r=buildConfirmationInsight([a],new Map([['activity',measurement]]),now);
    assert.equal(r.confirmed,0);
  }
});
test('snapshot freezes candidate attribution and detects changed schedule',()=>{
  const attribution={candidateId:'a',batchId:'b',startTime:'2026-10-28T16:00:00Z',endTime:'2026-10-28T17:00:00Z'};
  assert.deepEqual(confirmationAttribution({...attribution,recommendationAttribution:attribution}),attribution);
  assert.equal(confirmationAttribution({...attribution,startTime:'2026-10-28T18:00:00Z',recommendationAttribution:attribution}),null);
});
test('BQ13 reorders feasible measured slots, preserves unknown/base positions and ignores stale history',()=>{
  const context={date:'2026-10-30',members:[{},{}]};
  const slots=[{start:600,reasons:['base']},{start:800,reasons:['base']},{start:1100,reasons:['base']}];
  const insight={updated_at:now,by_segment:[{size:'2-3',category:'study',weekday:5,bucket:'morning',opportunities:20,confirmation_rate:10},
    {size:'2-3',category:'study',weekday:5,bucket:'evening',opportunities:20,confirmation_rate:60}]};
  const r=rankWithHistory(slots,context,insight,'study',now);
  assert.deepEqual(r.map(s=>s.start),[1100,800,600]);
  assert.match(r[0].reasons.at(-1),/Historical confirmation/);
  assert.deepEqual(rankWithHistory(slots,context,{...insight,updated_at:new Date(+now-3*DAY)},'study',now).map(s=>s.start),[600,800,1100]);
  assert.deepEqual(rankWithHistory(slots,context,null,'study',now).map(s=>s.start),[600,800,1100]);
  assert.deepEqual(rankWithHistory(slots,context,{...insight,environment:'test'},'study',now).map(s=>s.start),[600,800,1100]);
});
