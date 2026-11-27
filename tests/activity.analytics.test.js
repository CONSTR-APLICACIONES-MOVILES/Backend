const test=require('node:test'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService');
const {createMobileCallables}=require('../functions/src/mobileCallables');
const project='demo-parchapp-analytics-contracts',now=new Date('2026-11-24T22:00:00Z');
let app,db,api;
const call=(data,uid='reader')=>api.getActivityAnalytics.run({data,auth:uid?{uid}:undefined});
const filter=question=>({question,from:'2026-11-01',to:'2026-11-24'});
test.before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Emulator required');
  app=initializeApp({projectId:project},'analytics-contracts');db=getFirestore(app);
  api=createMobileCallables(new MobileService(db,{clock:()=>now}));
});
test.beforeEach(async()=>{
  const r=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(r.ok);
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
test('signed-in readers query only aggregates; anonymous, arbitrary fields and invalid date ranges fail',async()=>{
  await assert.rejects(call(filter('bq2'),null),{code:'unauthenticated'});
  await assert.rejects(call({...filter('bq2'),uid:'somebody'}),{code:'invalid-argument'});
  await assert.rejects(call({...filter('bq2'),from:'2026-01-01'}),{code:'invalid-argument'});
  await db.doc('creationAttempts/secret-attempt').set({uid:'secret-owner',attemptId:'secret-attempt',environment:'test',startedAt:new Date('2026-11-02T15:00:00Z'),outcome:'timeout',durationMs:8000});
  const data=await call(filter('bq2'));
  assert.equal(data.summary.attempts,1);assert.equal(data.summary.failure_or_timeout_pct,100);
  assert.ok(!JSON.stringify(data).includes('secret-owner'));assert.ok(!JSON.stringify(data).includes('secret-attempt'));
});
test('BQ3 reads raw exposure records with inclusive date boundaries and returns segmented acceptance',async()=>{
  const base={presentedAt:new Date('2026-11-02T05:00:00Z'),groupSize:3,category:'study',position:0,environment:'test',outcome:'ACCEPTED_UNCHANGED'};
  await db.doc('slotRecommendations/one').set(base);
  await db.doc('slotRecommendations/two').set({...base,position:1,outcome:'NOT_SELECTED'});
  await db.doc('slotRecommendations/historical').set({presentedAt:base.presentedAt,outcome:'MODIFIED',environment:'test'});
  const data=await call({...filter('bq3'),position:0,size:'2-3',category:'study'});
  assert.equal(data.available,3);assert.equal(data.matched,1);assert.equal(data.summary.pct_unchanged_overall,100);
  const all=await call(filter('bq3'));assert.equal(all.summary.sample_size,3);
  assert.ok(all.summary.by_position.some(r=>r.slot_position===-1));
});
test('BQ14 differentiates sufficient equal strategies from insufficient evidence and isolates cohorts',async()=>{
  const invitedAt=new Date('2026-11-10T17:00:00Z');
  for(const delay of [30,60])for(let i=0;i<20;i++){
    const id=`${delay}-${i}`;
    await db.doc(`reminderMeasurements/${id}`).set({invitedAt,groupSize:3,strategy:`single_after_${delay}_min`,environment:'test'});
    await db.doc(`coordinationMeasurements/${id}`).set({firstConfirmedAt:new Date(+invitedAt+60*60000)});
    await db.doc(`activities/${id}`).set({cancelled:false});
  }
  const data=await call({...filter('bq14'),size:'2-3'});
  const decision=data.summary.decisions.find(r=>r.size==='2-3');
  assert.equal(decision.sufficient,true);assert.equal(decision.strategy,null);assert.equal(decision.reason,'no clear joint improvement');
  assert.equal(data.summary.median_minutes,60);assert.equal(data.summary.notifications_per_activity,0);
  const arm=await call({...filter('bq14'),strategy:'single_after_30_min'});
  assert.equal(arm.matched,20);assert.equal(arm.summary.by_strategy_size.length,1);
});
