const test=require('node:test'),assert=require('node:assert/strict');
const {buildActivityAnalytics,filters,getActivityAnalytics}=require('../src/activityAnalytics');
const now=new Date('2026-11-24T22:00:00Z'),DAY=86400000;
const input=question=>({question,from:'2026-11-01',to:'2026-11-24'});
test('dates are inclusive Bogota days, weekly rates are weighted and no raw identities escape',()=>{
  const attempts=[
    {uid:'private-user',attemptId:'a',startedAt:new Date('2026-11-02T05:00:00Z'),outcome:'failure',environment:'test',durationMs:300},
    ...Array.from({length:9},(_,i)=>({uid:'private-user',attemptId:`b${i}`,startedAt:new Date('2026-11-03T14:00:00Z'),outcome:'success',environment:'test',durationMs:100})),
    {uid:'private-user',attemptId:'before',startedAt:new Date('2026-11-01T04:59:59Z'),environment:'test'},
  ];
  const data=buildActivityAnalytics({attempts},{...input('bq2'),granularity:'week'},now,'test');
  assert.equal(data.summary.attempts,10);assert.equal(data.summary.failure_or_timeout_pct,10);
  assert.equal(data.timeline.find(r=>r.date==='2026-11-02').failure_or_timeout_pct,10);
  assert.ok(!JSON.stringify(data).includes('private-user'));
  assert.equal(data.timeline.find(r=>r.date==='2026-11-09').failure_or_timeout_pct,null);
});
test('custom periods longer than thirty days include their actual records',()=>{
  const attempts=[{uid:'u',attemptId:'old',startedAt:new Date('2026-10-01T12:00:00Z'),outcome:'timeout',environment:'test'}];
  const data=buildActivityAnalytics({attempts},{question:'bq2',from:'2026-10-01',to:'2026-11-24'},now,'test');
  assert.equal(data.summary.attempts,1);assert.equal(data.summary.failure_or_timeout_pct,100);
});
test('BQ3 deduplicates candidates and filters size, position and category without confusing acceptance with confirmation',()=>{
  const a={id:'candidate-a',presentedAt:new Date('2026-11-10T17:00:00Z'),position:0,groupSize:3,category:'study',outcome:'ACCEPTED_UNCHANGED',environment:'test'};
  const data=buildActivityAnalytics({candidates:[a,a,{...a,id:'b',position:1,outcome:'NOT_SELECTED'},
    {...a,id:'c',category:'sports'}, {...a,id:'historical',groupSize:undefined,category:undefined,position:undefined}]},
    {...input('bq3'),size:'2-3',category:'study',position:0},now,'test');
  assert.equal(data.matched,1);assert.equal(data.available,4);assert.equal(data.summary.pct_unchanged_overall,100);
  const all=buildActivityAnalytics({candidates:[{...a,position:undefined}]},input('bq3'),now,'test');
  assert.equal(all.summary.by_position[0].slot_position,-1);assert.ok(!JSON.stringify(all).includes('NaN'));
});
test('BQ14 uses mature cohorts, includes zero alerts and separates initial confirmations and strategy arms',()=>{
  const invitedAt=new Date('2026-11-10T17:00:00Z');
  const reminders=[{activityId:'a',strategy:'single_after_30_min',groupSize:3,invitedAt,environment:'test'},
    {activityId:'b',strategy:'single_after_60_min',groupSize:3,invitedAt,environment:'test'},
    {activityId:'initial',strategy:'single_after_30_min',groupSize:3,invitedAt,environment:'test',initiallyConfirmed:true},
    {activityId:'pending',strategy:'single_after_30_min',groupSize:3,invitedAt:now,environment:'test'}];
  const measurements=new Map([['a',{firstConfirmedAt:new Date(+invitedAt+45*60000)}],['b',{firstConfirmedAt:null}],['initial',{firstConfirmedAt:invitedAt}]]);
  const data=buildActivityAnalytics({reminders,measurements,deliveries:[]},input('bq14'),now,'test');
  assert.equal(data.matched,3);assert.equal(data.summary.mature_activities,2);assert.equal(data.summary.pending,1);
  assert.equal(data.summary.median_minutes,45);assert.equal(data.summary.notifications_per_activity,0);
  const point=data.timeline.find(r=>r.date==='2026-11-10');
  assert.equal(point.strategies.single_after_30_min.confirmation_rate,100);
  assert.equal(point.strategies.single_after_60_min.confirmation_rate,0);
  const older=buildActivityAnalytics({reminders:[{...reminders[0],invitedAt:new Date('2026-10-01T12:00:00Z')}],measurements:new Map([['a',{firstConfirmedAt:null}]])},
    {question:'bq14',from:'2026-10-01',to:'2026-11-24'},now,'test');
  assert.equal(older.summary.mature_activities,1);
});
test('invalid dates, excessive ranges and irrelevant filters are rejected',()=>{
  for(const change of [{from:'2026-02-30'},{from:'2026-01-01'},{to:'2026-11-25'},{from:'2026-11-24',to:'2026-11-01'},{size:'2-3'},{category:'study'}]) {
    assert.throws(()=>filters({...input('bq2'),...change},now),{code:'invalid-argument'});
  }
});
test('BQ9 explorer filters comparison, category, size and confirmation window',()=>{
  const coordination=[
    {activityId:'a',createdAt:new Date('2026-11-10T17:00:00Z'),category:'study',groupSize:3,
      comparisonUsed:true,firstConfirmedAt:new Date('2026-11-12T17:00:00Z'),environment:'test'},
    {activityId:'b',createdAt:new Date('2026-11-10T17:00:00Z'),category:'sports',groupSize:5,
      comparisonUsed:false,firstConfirmedAt:new Date('2026-11-19T17:00:00Z'),environment:'test'},
    {activityId:'c',createdAt:new Date('2026-11-10T17:00:00Z'),category:'social',groupSize:2,
      comparisonUsed:null,firstConfirmedAt:null,environment:'test'},
  ];
  const data=buildActivityAnalytics({coordination},{...input('bq9'),comparison:'with_comparison',
    category:'study',size:'2-3'},now,'test');
  assert.equal(data.available,3);assert.equal(data.matched,1);assert.equal(data.summary.known,1);
  assert.equal(data.summary.compared.confirmation_pct,100);assert.equal(data.summary.direct.created,0);
  const all=buildActivityAnalytics({coordination},input('bq9'),now,'test');
  assert.equal(all.summary.total_activities,3);assert.equal(all.summary.known,2);
  assert.equal(all.summary.unknown,1);assert.equal(all.summary.difference_pp,100);
  assert.equal(all.summary.coverage_pct,66.7);assert.equal(all.summary.by_category.length,3);
  const wider=buildActivityAnalytics({coordination},{...input('bq9'),confirmationDays:30},now,'test');
  assert.equal(wider.summary.direct.confirmed,1);
  assert.throws(()=>filters({...input('bq9'),confirmationDays:2},now),{code:'invalid-argument'});
  assert.throws(()=>filters({...input('bq2'),comparison:'unknown'},now),{code:'invalid-argument'});
});
test('BQ9 explorer view exposes the filtered comparison rates and breakdown',async()=>{
  const {explorerView}=await import('../../dashboard/activity-explorer.mjs');
  const coordination=[
    {activityId:'a',createdAt:new Date('2026-11-10T17:00:00Z'),category:'study',groupSize:3,
      comparisonUsed:true,firstConfirmedAt:new Date('2026-11-12T17:00:00Z'),environment:'test'},
    {activityId:'b',createdAt:new Date('2026-11-10T17:00:00Z'),category:'sports',groupSize:5,
      comparisonUsed:false,firstConfirmedAt:null,environment:'test'},
  ];
  const data=buildActivityAnalytics({coordination},input('bq9'),now,'test');
  const view=explorerView(data);
  assert.equal(view.stats[0][1],'50%');
  assert.equal(view.stats[1][1],'100%');
  assert.equal(view.stats[2][1],'0%');
  const row=view.rows.find(r=>r[0]==='2026-11-10');
  assert.equal(row[7],0);
  assert.equal(view.breakdown.rows.length,4);
});
test('BQ9 callable reads activity documents and joins measurements',async()=>{
  const db={
    projectId:'parchapp',
    collection(name){
      assert.equal(name,'activities');
      return {where(){return this;},limit(){return this;},async get(){return {size:1,docs:[{id:'a',data:()=>({
        createdAt:new Date('2026-11-10T17:00:00Z'),category:'study',
        planningContext:{groupSizeAtCreation:3,comparisonUsed:true},
      })}]};}};
    },
    doc(path){return {path};},
    async getAll(...refs){return refs.map(ref=>({data:()=>ref.path==='coordinationMeasurements/a'?{
      comparisonUsed:true,firstConfirmedAt:new Date('2026-11-12T17:00:00Z'),environment:'production',
    }:undefined}));},
  };
  const data=await getActivityAnalytics(db,input('bq9'),now);
  assert.equal(data.matched,1);assert.equal(data.summary.compared.created,1);
  assert.equal(data.summary.compared.confirmation_pct,100);
});
test('cards tolerate partial legacy aggregates and explorer CSV retains nulls and formula safety',async()=>{
  const {createActivityQuestions}=await import('../../dashboard/activity-questions.mjs');
  const {aggregateCsv,explorerView}=await import('../../dashboard/activity-explorer.mjs');
  const qs=createActivityQuestions({reminderLabel:s=>s});
  assert.doesNotThrow(()=>qs.find(q=>q.id==='bq3').render({sample_size:2}));
  assert.doesNotThrow(()=>qs.find(q=>q.id==='bq14').render({total:2,by_strategy_size:[{notifications_per_activity:null}]}));
  const data=buildActivityAnalytics({attempts:[]},input('bq2'),now,'test');
  assert.equal(explorerView(data).stats[0][1],'—');
  assert.match(aggregateCsv(['Label','Rate'],[['=SUM(A1)',null]]),/'=SUM/);
});
