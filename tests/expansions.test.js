const test=require('node:test');
const assert=require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService');
const {createMobileCallables}=require('../functions/src/mobileCallables');
const {recordActivityChange}=require('../functions/src/alertEvents');
const project='demo-parchapp-phase-d';
let db,app,api,now;
const call=(name,data={},uid='owner')=>api[name].run({data,auth:uid?{uid}:undefined});
const search=extra=>({query:'',kind:'all',category:'all',limit:2,...extra});
const link=(extra={})=>call('createShareLink',{requestId:'link1',kind:'group',entityId:'g1',hours:24,...extra});
test.before(()=>{
 app=initializeApp({projectId:project},'phase-d');db=getFirestore(app);
 api=createMobileCallables(new MobileService(db,{clock:()=>now,userLookup:async uid=>({displayName:uid,email:`${uid}@test.example`})}));
});
test.beforeEach(async()=>{
 now=new Date('2026-10-20T13:00:00Z');
 assert.ok((await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'})).ok);
 await db.doc('groups/g1').set({name:'Study team',category:'study',ownerId:'owner',memberIds:['owner','peer'],members:[{id:'owner',name:'Owner',busy:[]},{id:'peer',name:'Camila',busy:[]}],goingIds:[],maybeIds:[],pendingInvites:[]});
 await db.doc('groups/private').set({name:'Secret outsiders',memberIds:['stranger'],members:[{id:'stranger',name:'Secret'}]});
 await db.doc('activities/a1').set({groupId:'g1',title:'Study activity',description:'Bring books',category:'study',status:'CONFIRMED',createdBy:'owner',createdAt:now,startTime:new Date('2026-10-20T15:00:00Z'),endTime:new Date('2026-10-20T16:00:00Z'),date:'2026-10-20',time:'10:00',location:'Library'});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});
test('discover pages are authorized, scoped to filters and recoverable',async()=>{
 const first=await call('discover',search());assert.equal(first.results.length,2);assert.ok(first.cursor);
 const next=await call('discover',search({cursor:first.cursor}));assert.equal(next.results.length,1);
 assert.ok([...first.results,...next.results].every(r=>!r.title.includes('Secret')));
 await assert.rejects(call('discover',search({query:'changed',cursor:first.cursor})),{code:'invalid-argument'});
 await assert.rejects(call('discover',search({cursor:first.cursor}),'peer'),{code:'invalid-argument'});
 assert.equal((await call('discover',search({query:'nonsense'}))).results.length,0);
 assert.equal((await call('discover',search({kind:'people'}))).results[0].title,'Camila');
 for(const extra of [{query:42},{kind:'public'},{limit:99},{category:'private'}])await assert.rejects(call('discover',search(extra)),{code:'invalid-argument'});
});
test('profile discovery exposes shared identity only',async()=>{
 await db.doc('profiles/peer').set({name:'Camila',studentId:'secret',program:'private',preferences:{statusVisibility:'private'}});
 assert.deepEqual(await call('getSharedProfile',{userId:'peer'}),{id:'peer',name:'Camila'});
 await assert.rejects(call('getSharedProfile',{userId:'stranger'}),{code:'permission-denied'});
});
test('share creation is idempotent, owner controlled and requires auth',async()=>{
 await assert.rejects(call('createShareLink',{requestId:'x',kind:'group',entityId:'g1'},null),{code:'unauthenticated'});
 await assert.rejects(call('createShareLink',{requestId:'x',kind:'group',entityId:'g1'},'peer'),{code:'permission-denied'});
 const [a,b]=await Promise.all([link(),link()]);assert.equal(a.token,b.token);assert.equal(a.linkId,b.linkId);
 await assert.rejects(link({hours:1}),{code:'already-exists'});
 assert.equal((await call('getShareLinks',{entityId:'g1'})).links.length,1);
});
test('bearer enrollment reveals only preview and persists explicit consent exactly once',async()=>{
 const saved=await link();const preview=await call('resolveShareLink',{token:saved.token},'stranger');
 assert.equal(preview.title,'Study team');assert.equal(preview.member,false);assert.equal(preview.members,undefined);
 assert.equal((await db.doc('groups/g1').get()).data().memberIds.includes('stranger'),false);
 await assert.rejects(call('getGroupDetails',{groupId:'g1'},'stranger'),{code:'permission-denied'});
 await Promise.all([call('joinSharedGroup',{token:saved.token},'stranger'),call('joinSharedGroup',{token:saved.token},'stranger')]);
 const group=(await db.doc('groups/g1').get()).data();assert.equal(group.memberIds.filter(id=>id==='stranger').length,1);
 assert.equal((await db.doc(`shareLinks/${saved.linkId}`).get()).data().uses,1);
 assert.equal((await call('getGroupDetails',{groupId:'g1'},'stranger')).name,'Study team');
});
test('expired, revoked and invalid links cannot enroll',async()=>{
 const first=await link();await assert.rejects(call('revokeShareLink',{linkId:first.linkId},'peer'),{code:'permission-denied'});
 await call('revokeShareLink',{linkId:first.linkId});await call('revokeShareLink',{linkId:first.linkId});
 await assert.rejects(call('resolveShareLink',{token:first.token},'stranger'),{code:'failed-precondition'});
 await assert.rejects(call('joinSharedGroup',{token:first.token},'stranger'),{code:'failed-precondition'});
 const second=await link({requestId:'second',hours:1});now=new Date('2026-10-20T14:00:00Z');
 await assert.rejects(call('joinSharedGroup',{token:second.token},'stranger'),{code:'failed-precondition'});
 await assert.rejects(call('resolveShareLink',{token:'bad'}),{code:'invalid-argument'});
});
test('activity and personal links preserve membership privacy',async()=>{
 const activity=await link({kind:'activity',entityId:'a1'});
 await assert.rejects(call('resolveShareLink',{token:activity.token},'stranger'),{code:'permission-denied'});
 assert.equal((await call('resolveShareLink',{token:activity.token},'peer')).entityId,'a1');
 const profile=await link({requestId:'profile',kind:'profile',entityId:'owner'});
 assert.equal((await call('resolveShareLink',{token:profile.token},'peer')).title,'Owner');
 await assert.rejects(call('resolveShareLink',{token:profile.token},'stranger'),{code:'permission-denied'});
 await assert.rejects(call('joinSharedGroup',{token:activity.token},'stranger'),{code:'invalid-argument'});
});
const materials=extra=>({activityId:'a1',expectedVersion:'none',topics:[{id:'topic1',title:'Review chapter'}],resources:[{id:'resource1',title:'Course material',url:'https://example.edu/material'}],...extra});
test('real resources and personal checklist persist independently for two users',async()=>{
 const saved=await call('saveActivityMaterials',materials());assert.equal(saved.canEdit,true);assert.notEqual(saved.version,'none');
 await call('saveActivityMaterials',materials()); // acknowledgement loss retry
 await call('setTopicCompletion',{activityId:'a1',topicId:'topic1',completed:true},'peer');
 assert.equal((await call('getActivityMaterials',{activityId:'a1'},'peer')).topics[0].completed,true);
 assert.equal((await call('getActivityMaterials',{activityId:'a1'})).topics[0].completed,false);
 await call('setTopicCompletion',{activityId:'a1',topicId:'topic1',completed:true},'peer');
 assert.equal((await call('getActivityMaterials',{activityId:'a1'},'peer')).resources[0].url,'https://example.edu/material');
});
test('materials enforce organizer, URL, version, removed-topic and cancellation checks',async()=>{
 await assert.rejects(call('saveActivityMaterials',materials(),'peer'),{code:'permission-denied'});
 await assert.rejects(call('getActivityMaterials',{activityId:'a1'},'stranger'),{code:'permission-denied'});
 await assert.rejects(call('saveActivityMaterials',materials({resources:[{id:'r',title:'Bad',url:'javascript:alert(1)'}]})),{code:'invalid-argument'});
 await assert.rejects(call('saveActivityMaterials',materials({resources:[{id:'r',title:'Bad',url:'https://user:password@example.edu/'}]})),{code:'invalid-argument'});
 const saved=await call('saveActivityMaterials',materials());
 await assert.rejects(call('saveActivityMaterials',materials({topics:[]})),{code:'aborted'});
 await call('saveActivityMaterials',materials({expectedVersion:saved.version,topics:[]}));
 await assert.rejects(call('setTopicCompletion',{activityId:'a1',topicId:'topic1',completed:true},'peer'),{code:'not-found'});
 await db.doc('activities/a1').update({cancelled:true});
 await assert.rejects(call('setTopicCompletion',{activityId:'a1',topicId:'topic1',completed:true},'peer'),{code:'failed-precondition'});
});
test('calendar export has canonical UTC times, stable UID, escaping and UTF-8 folding',async()=>{
 await db.doc('activities/a1').update({title:'Exam, semicolon; \\ newline\nBEGIN:VALARM '+ 'á'.repeat(100)});
 const file=await call('exportActivityCalendar',{activityId:'a1'},'peer');
 assert.ok(file.content.includes('DTSTART:20261020T150000Z\r\n'));assert.ok(file.content.includes('UID:a1@parchapp'));
 assert.ok(file.content.includes('SUMMARY:Exam\\, semicolon\\; \\\\ newline\\nBEGIN:VALARM'));
 assert.ok(file.content.split('\r\n').every(line=>Buffer.byteLength(line)<=75));
 await assert.rejects(call('exportActivityCalendar',{activityId:'a1'},'stranger'),{code:'permission-denied'});
 await db.doc('activities/a1').update({cancelled:true});await assert.rejects(call('exportActivityCalendar',{activityId:'a1'}),{code:'failed-precondition'});
});
test('calendar snapshot status changes only after successful import',async()=>{
 assert.equal((await call('getCalendarImportStatus')).lastImportedAt,null);
 await call('importCalendarAvailability',{startDate:'2026-10-20',days:1,intervals:[]});
 const saved=await call('getCalendarImportStatus');assert.equal(saved.lastImportedAt,now.toISOString());assert.equal(saved.automatic,false);
 await assert.rejects(call('importCalendarAvailability',{startDate:'invalid',days:1,intervals:[]}),{code:'invalid-argument'});
 assert.deepEqual(await call('getCalendarImportStatus'),saved);assert.equal((await call('getCalendarImportStatus',{},'peer')).lastImportedAt,null);
});
test('real time/cancel events are deduplicated, actionable and membership checked',async()=>{
 const before=(await db.doc('activities/a1').get()).data(),after={...before,startTime:new Date('2026-10-20T17:00:00Z')};
 await db.doc('activities/a1').update({startTime:after.startTime});
 await recordActivityChange(db,'a1',before,after,'2026-10-20T13:01:00Z');await recordActivityChange(db,'a1',before,after,'2026-10-20T13:01:00Z');
 let events=(await call('getAlerts',{},'peer')).alerts.filter(a=>a.kind==='timeChanged');assert.equal(events.length,1);assert.equal(events[0].studySessionId,'a1');
 await call('markAlertsRead',{ids:[events[0].id]},'peer');events=(await call('getAlerts',{},'peer')).alerts.filter(a=>a.kind==='timeChanged');assert.equal(events[0].isRead,true);
 assert.equal((await call('getAlerts',{},'stranger')).alerts.length,0);
 await recordActivityChange(db,'a1',after,{...after,cancelled:true},'2026-10-20T13:02:00Z');await db.doc('activities/a1').update({cancelled:true});
 assert.ok((await call('getAlerts',{},'peer')).alerts.some(a=>a.title==='Activity cancelled'));
});
test('group invitations and upcoming plans produce real alert kinds with persisted read state',async()=>{
 await call('createGroup',{requestId:'group-alert',name:'New team',category:'study',inviteeIds:['peer']});
 now=new Date('2026-10-20T14:30:00Z');
 const rows=(await call('getAlerts',{},'peer')).alerts;
 const group=rows.find(a=>a.kind==='groupInvite'),reminder=rows.find(a=>a.kind==='reminder');assert.ok(group.groupId);assert.equal(reminder.studySessionId,'a1');
 await call('markAlertsRead',{ids:[group.id,reminder.id]},'peer');
 assert.ok((await call('getAlerts',{},'peer')).alerts.filter(a=>[group.id,reminder.id].includes(a.id)).every(a=>a.isRead));
});
