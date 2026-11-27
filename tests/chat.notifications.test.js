const test=require('node:test'),assert=require('node:assert/strict');
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app'),{getFirestore,Timestamp}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService'),{createMobileCallables}=require('../functions/src/mobileCallables');
const {recordChatMessage}=require('../functions/src/chatAlerts');
const project='demo-parchapp-chat-notifications';let app,db,api;
const call=(name,data={},uid='alice')=>api[name].run({data,auth:uid?{uid}:undefined});
const chats=async(uid,includeChat=true)=>(await call('getAlerts',includeChat?{includeChat}:{},uid)).alerts.filter(a=>a.kind==='chatMessage');
const at=minute=>Timestamp.fromDate(new Date(Date.UTC(2026,10,25,15,minute)));
const message=(senderId,text,minute,extra={})=>({senderId,senderName:senderId==='alice'?'Alice Example':'Bob Example',
  senderInitials:senderId==='alice'?'AE':'BE',text,kind:'text',createdAt:at(minute),...extra});
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Use a disposable emulator');
 app=initializeApp({projectId:project},project);db=getFirestore(app);
 api=createMobileCallables(new MobileService(db,{userLookup:async uid=>({displayName:uid,email:`private-${uid}@example.test`})}));
});
test.beforeEach(async()=>{
 const response=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(response.ok);
 await db.doc('groups/study').set({name:'Study Group',memberIds:['alice','bob','carol'],members:[],createdAt:at(0)});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});

test('a House Chat message reaches the other members once per chat, never the sender',async()=>{
 assert.equal(await recordChatMessage(db,{groupId:'study'},'m1',message('alice','Hola grupo',1)),2);
 await recordChatMessage(db,{groupId:'study'},'m2',message('alice','Nos vemos a las 4',2));
 for(const uid of ['bob','carol']){
  const alerts=await chats(uid);assert.equal(alerts.length,1);
  assert.equal(alerts[0].title,'New message in Study Group');assert.equal(alerts[0].description,'Alice Example: Nos vemos a las 4');
  assert.equal(alerts[0].groupId,'study');assert.equal(alerts[0].chatFriendId,null);assert.equal(alerts[0].isRead,false);
  assert.match(alerts[0].id,/^chat_[a-f0-9]{64}$/);
 }
 assert.equal((await chats('alice')).length,0);
 // clients that do not ask for chat alerts (the Flutter app) do not get them
 assert.equal((await chats('bob',false)).length,0);
});

test('a direct message reaches only the other person and opens from a shared group',async()=>{
 await recordChatMessage(db,{pairId:'alice_bob'},'d1',message('bob','Hola Alice',1));
 const [alert]=await chats('alice');
 assert.equal(alert.title,'Bob Example sent you a message');assert.equal(alert.description,'Hola Alice');
 assert.equal(alert.chatFriendId,'bob');assert.equal(alert.chatFriendInitials,'BE');assert.equal(alert.groupId,'study');
 assert.equal((await chats('bob')).length,0);assert.equal((await chats('carol')).length,0);
 // a sender that is not part of the pair is ignored
 assert.equal(await recordChatMessage(db,{pairId:'alice_bob'},'d2',message('carol','spam',2)),0);
});

test('a read chat alert is unread again with the next message, and an older message never replaces a newer one',async()=>{
 await recordChatMessage(db,{groupId:'study'},'m1',message('alice','primero',1));
 const [first]=await chats('bob');
 await call('markNotificationEventsRead',{ids:[first.id]},'bob');
 assert.equal((await chats('bob'))[0].isRead,true);
 await recordChatMessage(db,{groupId:'study'},'m3',message('alice','tercero',3));
 await recordChatMessage(db,{groupId:'study'},'m2',message('alice','segundo',2));
 const [next]=await chats('bob');
 assert.notEqual(next.id,first.id);assert.equal(next.isRead,false);assert.equal(next.description,'Alice Example: tercero');
 await call('markAlertsRead',{ids:[next.id]},'bob');
 assert.equal((await chats('bob'))[0].isRead,true);
});

test('a member who left the group stops seeing its House Chat alert',async()=>{
 await recordChatMessage(db,{groupId:'study'},'m1',message('alice','Hola',1));
 await db.doc('groups/study').update({memberIds:['alice','bob']});
 assert.equal((await chats('carol')).length,0);
 await assert.rejects(call('getAlerts',{includeChat:'yes'},'bob'),{code:'invalid-argument'});
});
