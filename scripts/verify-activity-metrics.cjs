// End-to-end HTTP/Auth smoke. Strictly refuses production endpoints/projects.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const project='demo-parchapp-activity-metrics';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
const base=`http://127.0.0.1:5001/${project}/us-central1`;
async function post(url,body,token) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  return {status:response.status,body:await response.json()};
}
async function account(email) {
  const endpoint='http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:';
  const input={email,password:'MetricsQa123!',returnSecureToken:true};
  let r=await post(`${endpoint}signUp?key=emulator`,input);
  if(r.status!==200)r=await post(`${endpoint}signInWithPassword?key=emulator`,input);
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
(async()=>{
  const app=initializeApp({projectId:project},'metrics-http'),db=getFirestore(app);
  try {
    const reset=await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});
    assert.ok(reset.ok,'Dedicated disposable metrics project reset failed');
    const owner=await account('metrics.owner@example.test'),peer=await account('metrics.peer@example.test');
    const call=async(name,data={},who=owner,expected=200)=>{
      const r=await post(`${base}/${name}`,{data},who?.idToken);
      assert.equal(r.status,expected,`${name}: ${JSON.stringify(r.body)}`);
      return r.body.result ?? r.body.data;
    };
    await call('recordCreationAttempt',{},null,401);
    await call('refreshActivityInsights',{},null,401);
    await db.doc('groups/metrics-qa').set({name:'Metrics QA only',memberIds:[owner.localId,peer.localId],
      members:[owner,peer].map(a=>({id:a.localId,name:a.localId===owner.localId?'Metrics Owner':'Metrics Peer',busy:[]})),
      goingIds:[],maybeIds:[],pendingInvites:[]});
    const publication={requestId:`http-${Date.now()}`,groupId:'metrics-qa',fields:{title:'HTTP metrics QA',category:'study',status:'PROPOSED'}};
    const attempt={attemptId:publication.requestId,requestId:publication.requestId,startedAt:new Date().toISOString()};
    await call('recordCreationAttempt',{...attempt,phase:'start'});
    const start=performance.now(),created=await call('publishActivity',publication);
    await call('recordCreationAttempt',{...attempt,phase:'result',outcome:'success',durationMs:Math.round(performance.now()-start)});
    assert.deepEqual(await call('publishActivity',publication),created,'idempotent publication');
    await call('getActivity',{activityId:created.activityId},peer);
    const batch=await call('getActivityRecommendations',{activityId:created.activityId,durationMinutes:60,limit:3});
    if(batch.recommendations.length) {
      await call('presentActivityRecommendations',{activityId:created.activityId,recommendationIds:batch.recommendations.map(r=>r.id)});
      await call('acceptActivityRecommendation',{activityId:created.activityId,recommendationId:batch.recommendations[0].id});
    }
    await call('respondToActivityInvitation',{id:created.activityId,response:'accepted'},peer);
    const detail=await call('getActivity',{activityId:created.activityId});
    await call('updateActivityDetails',{activityId:created.activityId,expectedVersion:detail.version,
      fields:{title:detail.title,category:detail.category,status:'CONFIRMED',date:detail.date,time:detail.time,location:detail.location}});
    // Nine explicit reliability fixtures + the real successful HTTP attempt above
    // produce the guide's 10 / 2 failure / 1 timeout check in THIS DEMO ONLY.
    for (let i=0;i<9;i++) await call('recordCreationAttempt',{
      attemptId:`fixture-${publication.requestId}-${i}`,requestId:`fixture-${publication.requestId}-${i}`,
      startedAt:new Date().toISOString(),phase:'result',outcome:i<2?'failure':i===2?'timeout':'success',durationMs:i===2?8000:1000});
    // Historical fixture runs the real services with an injected clock, never
    // hand-written metric totals. It matures without asking a person to wait 24h.
    const {MobileService}=require('../functions/src/mobileService');
    const {ActivityService}=require('../functions/src/activityService');
    const {ActivityRepository}=require('../functions/src/activityRepository');
    let historical=new Date(Date.now()-2*86400000);
    historical.setUTCHours(13,0,0,0);
    const service=new MobileService(db,{clock:()=>historical});
    const recommendations=new ActivityService(new ActivityRepository(db),{clock:()=>historical});
    const old=await service.publishActivity(owner.localId,{...publication,requestId:`history-${publication.requestId}`});
    const oldBatch=await recommendations.getActivityRecommendations(owner.localId,{activityId:old.activityId,durationMinutes:60,limit:3});
    await recommendations.presentActivityRecommendations(owner.localId,{activityId:old.activityId,recommendationIds:oldBatch.recommendations.map(r=>r.id)});
    await recommendations.acceptActivityRecommendation(owner.localId,{activityId:old.activityId,recommendationId:oldBatch.recommendations[0].id});
    historical=new Date(+historical+3600000);
    const oldDetails=await recommendations.getActivity(owner.localId,{activityId:old.activityId});
    await service.updateActivityDetails(owner.localId,{activityId:old.activityId,expectedVersion:oldDetails.version,
      fields:{title:oldDetails.title,category:oldDetails.category,status:'CONFIRMED',date:oldDetails.date,time:oldDetails.time,location:oldDetails.location}});
    await call('refreshActivityInsights');
    const creation=(await db.doc('insights/bq2_creation_reliability').get()).data();
    const confirmation=(await db.doc('insights/bq13_recommendation_confirmation').get()).data();
    assert.equal(creation.environment,'test');assert.ok(creation.success>=1);
    assert.equal(confirmation.environment,'test');
    const report={checkedAt:new Date().toISOString(),project,result:'PASS',
      mode:'real emulator Auth tokens, HTTP callables, Firestore persistence; no production data',
      accounts:[owner.localId,peer.localId],activityId:created.activityId,
      candidates:batch.recommendations.length,attempts:creation.attempts,pending:confirmation.pending,
      fixtureNotice:'9 explicit reliability observations and one historical recommendation flow, DEMO ONLY',
      matureOpportunities:confirmation.mature_opportunities,confirmationRate:confirmation.confirmation_rate};
    const output=path.join(__dirname,'../tmp/activity-http.json');fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {await db.terminate();await deleteApp(app);}
})().catch(error=>{console.error(error);process.exitCode=1;});
