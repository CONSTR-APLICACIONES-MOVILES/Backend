// Shared real Firestore contracts; deterministic clock and two authenticated roles.
const test=require('node:test'), assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService');
const {createMobileCallables}=require('../functions/src/mobileCallables');
const {ActivityService}=require('../functions/src/activityService');
const {ActivityRepository}=require('../functions/src/activityRepository');
const {recordFirstConfirmation}=require('../functions/src/coordinationInsights');
const {refreshActivityInsights,recordCreationAttempt}=require('../functions/src/activityInsights');
const project='demo-parchapp-activity-contracts', DAY=86400000;
let app,db,mobile,api,activities,now;
const call=(name,data,uid='owner')=>api[name].run({data,auth:uid?{uid}:undefined});
test.before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Refuse to run without emulator');
  app=initializeApp({projectId:project},'activity-metrics'); db=getFirestore(app);
  mobile=new MobileService(db,{clock:()=>now,userLookup:async uid=>({email:`${uid}@example.test`})});
  api=createMobileCallables(mobile);
  activities=new ActivityService(new ActivityRepository(db),{clock:()=>now});
});
test.beforeEach(async()=>{
  now=new Date('2026-10-30T13:00:00Z');
  const result=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});
  assert.ok(result.ok);
  await db.doc('groups/g').set({name:'Metrics QA',memberIds:['owner','peer'],members:[{id:'owner',busy:[]},{id:'peer',busy:[]}],goingIds:[],maybeIds:[],pendingInvites:[]});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
const publication=(id='r')=>({requestId:id,groupId:'g',fields:{title:'Metrics QA',category:'study',status:'PROPOSED'}});
const attempt=extra=>({attemptId:'attempt',requestId:'request',startedAt:now.toISOString(),phase:'start',...extra});

test('BQ2 handles out-of-order delivery, immutable outcome, reconciliation and account authorization',async()=>{
  await assert.rejects(call('recordCreationAttempt',attempt(),null),{code:'unauthenticated'});
  await assert.rejects(call('recordCreationAttempt',attempt({clientUserId:'peer'})),{code:'permission-denied'});
  await assert.rejects(call('recordCreationAttempt',attempt({platform:'java'})),{code:'invalid-argument'});
  await call('recordCreationAttempt',attempt({phase:'result',outcome:'timeout',durationMs:8000}));
  await call('recordCreationAttempt',attempt());
  await call('recordCreationAttempt',attempt({phase:'reconcile',outcome:'success',durationMs:9000}));
  await call('recordCreationAttempt',attempt({phase:'result',outcome:'timeout',durationMs:8000}));
  await assert.rejects(call('recordCreationAttempt',attempt({phase:'result',outcome:'success',durationMs:9000})),{code:'already-exists'});
  await call('recordCreationAttempt',attempt(),'peer');
  await refreshActivityInsights(db,now);
  const r=(await db.doc('insights/bq2_creation_reliability').get()).data();
  assert.equal(r.attempts,2);assert.equal(r.timeout,1);assert.equal(r.unresolved,1);assert.equal(r.reconciled_success,1);
  assert.equal(r.failure_or_timeout_pct,50);assert.equal(r.environment,'test');
});
test('BQ2 exact fixture: 10 network attempts, 2 failures and 1 timeout, slow successes remain successes',async()=>{
  for(let i=0;i<10;i++) await recordCreationAttempt(db,'owner',attempt({attemptId:`a${i}`,phase:'result',outcome:i<2?'failure':i===2?'timeout':'success',durationMs:i===2?8000:9000}),now);
  await refreshActivityInsights(db,now);
  const r=(await db.doc('insights/bq2_creation_reliability').get()).data();
  assert.equal(r.attempts,10);assert.equal(r.failure_or_timeout_pct,30);assert.equal(r.coverage_pct,100);
});

async function select(outcome='ACCEPTED_UNCHANGED',confirmedAtCreation=false) {
  const input=publication();if(confirmedAtCreation)input.fields.status='CONFIRMED';
  const {activityId}=await call('publishActivity',input);
  // Legacy Java publication payload remains valid without new telemetry fields.
  assert.equal((await activities.getActivity('peer',{activityId})).title,'Metrics QA');
  const batch=await activities.getActivityRecommendations('owner',{activityId,durationMinutes:60,limit:3});
  await activities.presentActivityRecommendations('owner',{activityId,recommendationIds:batch.recommendations.map(r=>r.id)});
  const chosen=batch.recommendations[0];
  if(outcome==='MODIFIED')await activities.modifyActivityRecommendation('owner',{activityId,recommendationId:chosen.id,startTime:'2026-10-30T20:00:00Z',endTime:'2026-10-30T21:00:00Z'});
  else await activities.acceptActivityRecommendation('owner',{activityId,recommendationId:chosen.id});
  return {activityId,batch,chosen};
}
async function confirm(activityId) {
  now=new Date(+now+3600000);
  const details=await activities.getActivity('owner',{activityId});
  await call('updateActivityDetails',{activityId,expectedVersion:details.version,fields:{title:details.title,category:details.category,status:'CONFIRMED',date:details.date,time:details.time,location:details.location}});
}
test('BQ13 actual publication -> presented -> selected -> first confirmation -> aggregate; retries do not multiply',async()=>{
  const {activityId,batch,chosen}=await select();
  await activities.acceptActivityRecommendation('owner',{activityId,recommendationId:chosen.id});
  await confirm(activityId);
  const measurement=(await db.doc(`coordinationMeasurements/${activityId}`).get()).data();
  assert.equal(measurement.confirmationRecommendation.candidateId,chosen.id);
  // A later edit must not erase the frozen first-confirmation interval.
  await db.doc(`activities/${activityId}`).update({startTime:new Date('2026-10-30T21:00:00Z')});
  now=new Date(+now+DAY);
  await refreshActivityInsights(db,now);
  const r=(await db.doc('insights/bq13_recommendation_confirmation').get()).data();
  assert.equal(r.mature_opportunities,3);assert.equal(r.confirmed,1);assert.equal(r.confirmation_rate,33.33);
  const bq3=(await db.doc('insights/bq3_slot_acceptance').get()).data();
  assert.equal(bq3.sample_size,batch.recommendations.length);assert.equal(bq3.accepted_recommendations_unchanged,1);
});
test('BQ13 modified choice, no confirmation and confirmation before selection do not convert',async()=>{
  const {activityId}=await select('MODIFIED');await confirm(activityId);
  now=new Date(+now+DAY);await refreshActivityInsights(db,now);
  assert.equal((await db.doc('insights/bq13_recommendation_confirmation').get()).data().confirmed,0);
});
test('BQ13 creation already CONFIRMED is not credited retroactively to later suggestions',async()=>{
  await select('ACCEPTED_UNCHANGED',true);
  now=new Date(+now+2*DAY);await refreshActivityInsights(db,now);
  assert.equal((await db.doc('insights/bq13_recommendation_confirmation').get()).data().confirmed,0);
});
test('confirmation trigger freezes earliest legacy-Java transition and never overwrites it with reconfirmation',async()=>{
  const attribution={candidateId:'candidate',batchId:'batch',startTime:'2026-10-30T16:00:00Z',endTime:'2026-10-30T17:00:00Z'};
  const after={status:'CONFIRMED',createdAt:now,startTime:new Date(attribution.startTime),endTime:new Date(attribution.endTime),recommendationAttribution:attribution};
  await recordFirstConfirmation(db,'legacy',{status:'PROPOSED'},after,now);
  await recordFirstConfirmation(db,'legacy',{status:'PROPOSED'},{...after,recommendationAttribution:{...attribution,candidateId:'later'}},new Date(+now+DAY));
  const r=(await db.doc('coordinationMeasurements/legacy').get()).data();
  assert.equal(r.confirmationRecommendation.candidateId,'candidate');assert.equal(+r.firstConfirmedAt.toDate(),+now);
});
test('BQ13 sufficient history changes shared Java/Flutter recommendations, never restores infeasible times',async()=>{
  const {activityId}=await call('publishActivity',publication());
  await db.doc('insights/bq13_recommendation_confirmation').set({environment:'test',updated_at:now,by_segment:[
    {size:'2-3',category:'study',weekday:5,bucket:'morning',opportunities:20,confirmation_rate:10},
    {size:'2-3',category:'study',weekday:5,bucket:'afternoon',opportunities:20,confirmation_rate:80}]});
  const r=await activities.getActivityRecommendations('owner',{activityId,durationMinutes:60,limit:3});
  assert.match(r.recommendations[0].reasons.at(-1),/80%/);
  await db.doc('groups/g').update({members:[{id:'owner',busy:[]},{id:'peer',busy:[{start:720,end:1440}]}]});
  const limited=await activities.getActivityRecommendations('owner',{activityId,durationMinutes:60,limit:3});
  assert.ok(limited.recommendations.every(r=>Date.parse(r.endTime)<=Date.parse('2026-10-30T17:00:00Z')));
});
