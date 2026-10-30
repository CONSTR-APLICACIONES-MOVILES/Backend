const test=require('node:test'),assert=require('node:assert/strict');
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app'),{getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService'),{createMobileCallables}=require('../functions/src/mobileCallables');
const project='demo-parchapp-friend-notifications';let app,db,api;
const call=(name,data={},uid='alice')=>api[name].run({data,auth:uid?{uid}:undefined});
const requests=async uid=>(await call('getAlerts',{},uid)).alerts.filter(a=>a.kind==='friendRequest');
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Use a disposable emulator');
 app=initializeApp({projectId:project},project);db=getFirestore(app);
 api=createMobileCallables(new MobileService(db,{userLookup:async uid=>({displayName:uid==='alice'?'Alice Example':'Bob Example',email:`private-${uid}@example.test`})}));
});
test.beforeEach(async()=>{
 const response=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(response.ok);
 await call('setUsername',{username:'alice.example'});await call('setUsername',{username:'bob.example'},'bob');
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
const send=version=>call('changeFriendship',{userId:'bob',action:'request',expectedVersion:version||'none'});
test('pending requests without a shared group appear once, only to the recipient, including existing requests',async()=>{
 const [sent,retried]=await Promise.all([send(),send()]);assert.deepEqual(sent,retried);
 const alerts=await requests('bob');assert.equal(alerts.length,1);
 const alert=alerts[0];assert.equal(alert.requesterId,'alice');assert.equal(alert.requesterName,'Alice Example');
 assert.equal(alert.requesterUsername,'alice.example');assert.equal(alert.friendshipVersion,sent.version);assert.equal(alert.isRead,false);
 assert.match(alert.id,/^friend_[a-f0-9]{64}$/);
 assert.deepEqual(Object.keys(alert).sort(),['id','kind','title','description','createdAt','requesterId','requesterName','requesterUsername','friendshipVersion','studySessionId','isRead','response'].sort());
 assert.equal((await requests('alice')).length,0);assert.equal((await requests('stranger')).length,0);
 assert.equal((await requests('bob'))[0].id,alert.id);
});
test('reading a friendship alert is recipient-scoped and never accepts the request',async()=>{
 await send();const [alert]=await requests('bob');
 await call('markNotificationEventsRead',{ids:[alert.id]},'bob');
 assert.equal((await requests('bob'))[0].isRead,true);
 assert.equal((await call('getFriends',{},'bob')).relationships[0].state,'pending');
 await assert.rejects(call('markNotificationEventsRead',{ids:[alert.id]},'stranger'));
 await assert.rejects(call('markNotificationEventsRead',{ids:[alert.id],clientUserId:'bob'},'stranger'),{code:'permission-denied'});
 await assert.rejects(call('getAlerts',{},null),{code:'unauthenticated'});
});
test('cancellation removes the alert; a renewed request gets a new unread identity',async()=>{
 const sent=await send();const [old]=await requests('bob');await call('markNotificationEventsRead',{ids:[old.id]},'bob');
 const cancelled=await call('changeFriendship',{userId:'bob',action:'cancel',expectedVersion:sent.version});
 assert.equal((await requests('bob')).length,0);
 await send(cancelled.version);const [renewed]=await requests('bob');
 assert.notEqual(renewed.id,old.id);assert.equal(renewed.isRead,false);
 await assert.rejects(call('markNotificationEventsRead',{ids:[old.id]},'bob'));
 await assert.rejects(call('changeFriendship',{userId:'alice',action:'accept',expectedVersion:old.friendshipVersion},'bob'),{code:'aborted'});
});
for(const action of ['accept','decline'])test(`recipient can ${action} from the notification metadata with an idempotent retry`,async()=>{
 await send();const [alert]=await requests('bob');
 await assert.rejects(call('changeFriendship',{userId:'bob',action,expectedVersion:alert.friendshipVersion}),{code:'permission-denied'});
 const input={userId:alert.requesterId,action,expectedVersion:alert.friendshipVersion,clientUserId:'bob'};
 const result=await call('changeFriendship',input,'bob');assert.deepEqual(await call('changeFriendship',input,'bob'),result);
 assert.equal((await requests('bob')).length,0);
 assert.equal((await call('getFriends',{},'bob')).relationships.length,action==='accept'?1:0);
  const accepted=(await call('getAlerts',{},'alice')).alerts.filter(a=>a.kind==='digest');
  assert.equal(accepted.length,action==='accept'?1:0);
  if(action==='accept') {
    assert.match(accepted[0].title,/Bob Example accepted your friend request/);
    await call('markNotificationEventsRead',{ids:[accepted[0].id]},'alice');
    assert.equal((await call('getAlerts',{},'alice')).alerts.find(a=>a.id===accepted[0].id).isRead,true);
  }
});
