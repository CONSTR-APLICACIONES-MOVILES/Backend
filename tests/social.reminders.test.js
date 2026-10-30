const test=require('node:test'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');const {getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService');const {createMobileCallables}=require('../functions/src/mobileCallables');
const {dispatchPendingReminders,refreshReminderInsight,chooseReminderPolicy}=require('../functions/src/reminderInsights');
const {createHash}=require('node:crypto');
const project='demo-parchapp-social-reminders';let app,db,service,api,now;
const call=(name,data={},uid='a')=>api[name].run({data,auth:uid?{uid}:undefined});
test.before(()=>{assert.ok(process.env.FIRESTORE_EMULATOR_HOST);app=initializeApp({projectId:project},'social-reminders');db=getFirestore(app);
  service=new MobileService(db,{clock:()=>now,userLookup:async uid=>({displayName:`Person ${uid}`,email:`private-${uid}@example.test`})});api=createMobileCallables(service);});
test.beforeEach(async()=>{
  now=new Date('2026-10-30T13:00:00Z');
  const r=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(r.ok);
  await db.doc('groups/g').set({memberIds:['a','b'],members:[{id:'a',busy:[]},{id:'b',busy:[]}],goingIds:[],maybeIds:[],pendingInvites:[]});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
test('username normalization, uniqueness under concurrency, rename release and no private directory fields',async()=>{
  const results=await Promise.allSettled([call('setUsername',{username:'@Shared.Name'}),call('setUsername',{username:'shared.name'},'b')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const owner=(await db.doc('usernames/shared.name').get()).data().uid;
  await call('setUsername',{username:'other_name'},owner);
  await call('setUsername',{username:'shared.name'},owner==='a'?'b':'a');
  const found=await call('searchPeople',{query:'shared'},owner);
  assert.equal(found.people.length,1);assert.deepEqual(Object.keys(found.people[0]).sort(),['id','name','username']);
  await assert.rejects(call('setUsername',{username:'two words'}),{code:'invalid-argument'});
  await assert.rejects(call('setUsername',{username:'abc',clientUserId:'b'}),{code:'permission-denied'});
});
test('accounts without shared groups: request -> receiver accept -> both lists -> removal and idempotent retry',async()=>{
  await call('setUsername',{username:'alice'});await call('setUsername',{username:'bob'},'outsider');
  const found=await call('searchPeople',{query:'bo'});assert.equal(found.people[0].id,'outsider');
  const input={userId:'outsider',action:'request',expectedVersion:'none'};
  const sent=await call('changeFriendship',input);assert.equal(sent.state,'pending');
  assert.deepEqual(await call('changeFriendship',input),sent);
  await assert.rejects(call('changeFriendship',{userId:'outsider',action:'accept',expectedVersion:sent.version}),{code:'permission-denied'});
  const accepted=await call('changeFriendship',{userId:'a',action:'accept',expectedVersion:sent.version},'outsider');
  assert.equal(accepted.state,'accepted');assert.equal((await call('getFriends')).relationships[0].state,'accepted');
  assert.equal((await call('getFriends',{},'outsider')).relationships[0].state,'accepted');
  const removed=await call('changeFriendship',{userId:'outsider',action:'remove',expectedVersion:accepted.version});
  assert.equal(removed.state,'removed');assert.equal((await call('getFriends')).relationships.length,0);
  assert.deepEqual((await db.doc('groups/g').get()).data().memberIds,['a','b']);
  await assert.rejects(call('changeFriendship',input),{code:'aborted'});
});
test('self friendship, forged cursor, reversed requests and stale responses are rejected',async()=>{
  await call('setUsername',{username:'alice'});await call('setUsername',{username:'bobby'},'b');
  await assert.rejects(call('changeFriendship',{userId:'a',action:'request',expectedVersion:'none'}),{code:'invalid-argument'});
  const r=await call('changeFriendship',{userId:'b',action:'request',expectedVersion:'none'});
  await assert.rejects(call('changeFriendship',{userId:'a',action:'request',expectedVersion:'none'},'b'),{code:'aborted'});
  const declined=await call('changeFriendship',{userId:'a',action:'decline',expectedVersion:r.version},'b');
  await assert.rejects(call('changeFriendship',{userId:'a',action:'accept',expectedVersion:r.version},'b'),{code:'aborted'});
  assert.equal(declined.state,'declined');await assert.rejects(call('searchPeople',{query:'al',cursor:'garbage'}),{code:'invalid-argument'});
});
test('public name follows profile edits while email/student fields remain private and friendship never changes schedules',async()=>{
  await call('setUsername',{username:'alice'});
  await call('updateProfile',{fields:{name:'Alice New',studentId:'SECRET',campus:'PRIVATE'}});
  const person=await call('getPublicPerson',{userId:'a'},'outsider');assert.equal(person.name,'Alice New');
  assert.equal(person.studentId,undefined);assert.equal(person.email,undefined);assert.equal(person.campus,undefined);
  assert.equal((await call('getScheduleFriends',{},'outsider')).friends.length,0);
});
function requestFor(strategy){
  for(let i=0;i<200;i++){
    const requestId=`r${i}`,activityId=`mobile-${createHash('sha256').update(JSON.stringify(['a',requestId])).digest('hex').slice(0,40)}`;
    if(chooseReminderPolicy(activityId,2,now,null,'test').strategy===strategy)return requestId;
  }throw new Error('Policy fixture unavailable');
}
async function publish(strategy,extra={}){
  return call('publishActivity',{requestId:requestFor(strategy),groupId:'g',startTime:'2026-10-30T20:00:00Z',endTime:'2026-10-30T21:00:00Z',timeZone:'America/Bogota',fields:{title:'BQ14 QA',status:'PROPOSED'},...extra});
}
test('two frozen RSVP strategies, concurrent dispatch, one delivery per recipient and activity-level aggregation',async()=>{
  const a=await publish('single_after_30_min'),b=await publish('single_after_60_min');
  now=new Date('2026-10-30T13:31:00Z');await Promise.all([dispatchPendingReminders(db,now),dispatchPendingReminders(db,now)]);
  assert.equal((await db.doc(`inboxes/b/items/${a.activityId}`).get()).data().reminderCount,1);
  assert.equal((await db.doc(`inboxes/b/items/${b.activityId}`).get()).data().reminderCount,0);
  await db.doc(`coordinationMeasurements/${a.activityId}`).set({firstConfirmedAt:new Date('2026-10-30T13:45:00Z')},{merge:true});
  now=new Date('2026-10-30T14:01:00Z');await dispatchPendingReminders(db,now);
  await db.doc(`coordinationMeasurements/${b.activityId}`).set({firstConfirmedAt:new Date('2026-10-30T14:30:00Z')},{merge:true});
  const result=await refreshReminderInsight(db,new Date('2026-11-01T13:00:00Z'));
  assert.equal(result.mature_activities,2);assert.equal(result.by_strategy_size[0].notifications,1);
  assert.deepEqual(result.by_strategy_size.map(r=>r.median_minutes).sort((a,b)=>a-b),[45,90]);
  assert.ok(result.decisions.every(d=>!d.sufficient));
});
test('responses/cancellation/confirmation before due suppress reminders; initial confirmation stays a zero-alert activity',async()=>{
  const a=await publish('single_after_30_min');await call('respondToActivityInvitation',{id:a.activityId,response:'accepted'},'b');
  now=new Date('2026-10-30T14:05:00Z');await dispatchPendingReminders(db,now);
  assert.equal((await db.doc(`inboxes/b/items/${a.activityId}/reminders/initial`).get()).data().status,'CANCELLED');
  const b=await publish('single_after_60_min',{fields:{title:'Immediate QA',status:'CONFIRMED'}});
  assert.equal((await db.doc(`inboxes/b/items/${b.activityId}/reminders/initial`).get()).exists,false);
  const result=await refreshReminderInsight(db,new Date('2026-11-01T15:00:00Z'));
  assert.ok(result.by_strategy_size.some(r=>r.initially_confirmed===1&&r.notifications===0));
});
