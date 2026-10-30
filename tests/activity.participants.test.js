const test=require('node:test'), assert=require('node:assert/strict');
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService');
const {createMobileCallables}=require('../functions/src/mobileCallables');
const {pair}=require('../functions/src/socialService');
const project='demo-parchapp-participants';let app,db,api;
const call=(name,data={},uid='owner')=>api[name].run({data,auth:uid?{uid}:undefined});
const details=uid=>call('getActivityParticipants',{activityId:'plan'},uid);
test.before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Use a disposable emulator');
  app=initializeApp({projectId:project},project);db=getFirestore(app);api=createMobileCallables(new MobileService(db,{userLookup:async uid=>({uid,displayName:uid,email:`${uid}@example.test`})}));
});
test.beforeEach(async()=>{
  const res=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(res.ok);
  await db.doc('groups/team').set({name:'Team',ownerId:'owner',memberIds:['owner','member','other'],
    members:['owner','member','other'].map(id=>({id,name:id})),goingIds:[],maybeIds:[],invitedIds:[]});
  await db.doc('activities/plan').set({groupId:'team',createdBy:'owner',participantIds:['owner'],title:'Plan',createdAt:new Date(),status:'PROPOSED'});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
test('only members can read or join; only organizer can invite and remove',async()=>{
  const d=await details('member');assert.equal(d.canJoin,true);assert.equal(d.canManage,false);
  await assert.rejects(details('outsider'),{code:'permission-denied'});
  await assert.rejects(call('getActivityParticipants',{activityId:'plan'},null),{code:'unauthenticated'});
  for(const action of ['invite','remove'])await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action,userId:'other',expectedVersion:d.version},'member'),{code:'permission-denied'});
  await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action:'join',expectedVersion:d.version},'outsider'),{code:'permission-denied'});
  await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action:'join',expectedVersion:d.version,clientUserId:'member'},'other'),{code:'permission-denied'});
});
test('member joins without editing the session and records consent once',async()=>{
  const d=await details('member'),input={activityId:'plan',action:'join',expectedVersion:d.version};
  await call('changeActivityParticipants',input,'member');await call('changeActivityParticipants',input,'member');
  const a=(await db.doc('activities/plan').get()).data();assert.deepEqual(a.participantIds,['member','owner']);assert.equal(a.title,'Plan');assert.equal(a.createdBy,'owner');
  const inbox=(await db.doc('inboxes/member/items/plan').get()).data();assert.equal(inbox.response,'accepted');assert.equal(inbox.responseMs,0);
  assert.equal((await db.doc('activities/plan/lifecycle/response-member').get()).data().response,'accepted');
  assert.equal((await details('member')).joined,true);
});
test('organizer invitation reaches Alerts, preserves responses on retry, and removal withdraws access to invitation',async()=>{
  const input={activityId:'plan',action:'invite',userId:'member',expectedVersion:(await details('owner')).version};
  await call('changeActivityParticipants',input);assert.equal((await call('getAlerts',{},'member')).alerts.filter(a=>a.id==='plan').length,1);
  await call('respondToActivityInvitation',{id:'plan',response:'accepted'},'member');
  await call('changeActivityParticipants',input);assert.equal((await db.doc('inboxes/member/items/plan').get()).data().response,'accepted');
  await call('changeActivityParticipants',{activityId:'plan',action:'remove',userId:'member',expectedVersion:(await details('owner')).version});
  assert.equal((await call('getAlerts',{},'member')).alerts.filter(a=>a.id==='plan').length,0);
  await assert.rejects(call('respondToActivityInvitation',{id:'plan',response:'accepted'},'member'),{code:'permission-denied'});
  assert.equal((await db.doc('inboxes/member/items/plan').get()).exists,false);
});
test('stale versions, cancelled activities and removing the organizer are rejected',async()=>{
  const old=(await details('owner')).version;
  await call('changeActivityParticipants',{activityId:'plan',action:'invite',userId:'member',expectedVersion:old});
  await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action:'invite',userId:'other',expectedVersion:old}),{code:'aborted'});
  await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action:'remove',userId:'owner',expectedVersion:old}),{code:'failed-precondition'});
  await db.doc('activities/plan').update({cancelled:true});
  await assert.rejects(call('changeActivityParticipants',{activityId:'plan',action:'join',expectedVersion:(await details('other')).version},'other'),{code:'failed-precondition'});
});
test('legacy activities retain existing group participants when changed',async()=>{
  const {FieldValue}=req('firebase-admin/firestore');
  await db.doc('activities/plan').update({participantIds:FieldValue.delete()});
  const d=await details('owner');assert.equal(d.members.filter(m=>m.invited).length,3);
  await call('changeActivityParticipants',{activityId:'plan',action:'remove',userId:'other',expectedVersion:d.version});
  assert.deepEqual((await db.doc('activities/plan').get()).data().participantIds,['member','owner']);
});
test('friend group invitations are consented, owner-only and idempotent',async()=>{
  await db.doc(`friendships/${pair('owner','friend')}`).set({state:'accepted',memberIds:['owner','friend']});
  await db.doc('publicPeople/friend').set({name:'Friend',username:'friend'});
  const input={groupId:'team',userId:'friend'};
  await assert.rejects(call('inviteGroupFriend',input,'member'),{code:'permission-denied'});
  await assert.rejects(call('inviteGroupFriend',{groupId:'team',userId:'stranger'}),{code:'permission-denied'});
  await call('inviteGroupFriend',input);const first=(await db.doc('groupInvitations/friend/items/team').get()).data();
  await call('inviteGroupFriend',input);assert.deepEqual((await db.doc('groupInvitations/friend/items/team').get()).data(),first);
  assert.equal((await call('getAlerts',{},'friend')).alerts.filter(a=>a.kind==='groupInvite').length,1);
  assert.equal((await db.doc('groups/team').get()).data().memberIds.includes('friend'),false);
});
test('attendance can change declined -> maybe -> accepted -> declined; first response metrics survive',async()=>{
  await call('changeActivityParticipants',{activityId:'plan',action:'invite',userId:'member',expectedVersion:(await details('owner')).version});
  let previous=null, first;
  for(const response of ['declined','maybe','accepted','declined']) {
    const input={id:'plan',response,expectedResponse:previous};
    await call('respondToActivityInvitation',input,'member');
    await call('respondToActivityInvitation',input,'member');
    const state=(await db.doc('inboxes/member/items/plan').get()).data();
    first ||= state;
    assert.equal(state.response,response);assert.equal(state.firstResponse,'declined');
    assert.equal(state.respondedAt.toMillis(),first.respondedAt.toMillis());assert.equal(state.responseMs,first.responseMs);
    assert.equal((await details('owner')).members.find(m=>m.id==='member').response,response);
    previous=response;
  }
  await assert.rejects(call('respondToActivityInvitation',{id:'plan',response:'accepted',expectedResponse:'maybe'},'member'),{code:'aborted'});
  await assert.rejects(call('respondToActivityInvitation',{id:'plan',response:'accepted'},'outsider'),{code:'permission-denied'});
  await db.doc('activities/plan').update({cancelled:true});
  await assert.rejects(call('respondToActivityInvitation',{id:'plan',response:'maybe',expectedResponse:'declined'},'member'),{code:'failed-precondition'});
});
test('Quick Status accepts Dart microseconds, persists and remains private when requested',async()=>{
  const expiresAt=new Date(Date.now()+3600000).toISOString().replace('Z','123Z');
  const result=await call('updatePresence',{status:'busy',visibility:'private',expiresAt,clientUserId:'owner'});
  assert.equal(result.status,'busy');assert.equal(result.preferences.statusVisibility,'private');
  const stored=(await db.doc('profiles/owner').get()).data();assert.equal(stored.status,'busy');assert.equal(stored.statusExpiresAt.toDate().getTime(),Date.parse(expiresAt));
  assert.equal((await call('getGroupDetails',{groupId:'team'},'member')).members.find(m=>m.id==='owner').status,null);
  await assert.rejects(call('updatePresence',{status:'busy',visibility:'groups',expiresAt:'invalid'}),{code:'invalid-argument'});
  await assert.rejects(call('updatePresence',{status:'busy',visibility:'groups',expiresAt:new Date(Date.now()-10000).toISOString()}),{code:'invalid-argument'});
  await assert.rejects(call('updatePresence',{status:'busy',visibility:'groups',expiresAt,clientUserId:'owner'},'member'),{code:'permission-denied'});
});
