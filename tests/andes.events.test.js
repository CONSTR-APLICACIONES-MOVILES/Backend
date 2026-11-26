const test=require('node:test'),assert=require('node:assert/strict');
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app'),{getFirestore,Timestamp}=req('firebase-admin/firestore');
const {MobileService}=require('../functions/src/mobileService'),{createMobileCallables}=require('../functions/src/mobileCallables');
const project='demo-parchapp-andes-events';let app,db,api;
// "now" is Nov 25 2026, 10:00 in Bogota (15:00 UTC)
const NOW=new Date(Date.UTC(2026,10,25,15,0));
const call=(name,data={},uid='alice')=>api[name].run({data,auth:uid?{uid}:undefined});
const bogota=(day,hour,minute=0)=>new Date(Date.UTC(2026,10,day,hour+5,minute));
const event=(over={})=>({title:'Feria de emprendimiento',description:'Stands y charlas de emprendedores.',category:'Academic',
  location:'Edificio Santo Domingo',start:Timestamp.fromDate(bogota(25,14)),end:Timestamp.fromDate(bogota(25,16)),published:true,...over});
const failure=async(promise,code)=>{await assert.rejects(promise,error=>{assert.equal(error.code,code);return true;});};
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Use a disposable emulator');
 app=initializeApp({projectId:project},project);db=getFirestore(app);
 api=createMobileCallables(new MobileService(db,{clock:()=>NOW,userLookup:async uid=>({displayName:uid})}));
});
test.beforeEach(async()=>{
 const response=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});assert.ok(response.ok);
 await db.doc('groups/study').set({name:'Study',memberIds:['alice','bob'],members:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}]});
});
test.after(async()=>{await db?.terminate();if(app)await deleteApp(app);});

test('the catalog lists published upcoming events by start and counts invalid ones',async()=>{
 await db.doc('andesEvents/later').set(event({title:'Concierto',category:'cultural',start:Timestamp.fromDate(bogota(30,18)),end:Timestamp.fromDate(bogota(30,20))}));
 await db.doc('andesEvents/feria').set(event());
 await db.doc('andesEvents/ended').set(event({start:Timestamp.fromDate(bogota(24,8)),end:Timestamp.fromDate(bogota(24,9))}));
 await db.doc('andesEvents/draft').set(event({published:false}));
 await db.doc('andesEvents/broken').set(event({location:'  '}));
 await db.doc('andesEvents/club').set(event({category:'Club de ajedrez'}));
 const result=await call('getAndesEvents');
 // same start: ordered by id
 assert.deepEqual(result.events.map(e=>e.id),['club','feria','later']);
 assert.equal(result.events[1].category,'academic');assert.equal(result.events[0].category,'other');
 assert.equal(result.events[1].start,bogota(25,14).toISOString());
 assert.equal(result.invalidCount,1);assert.deepEqual(result.addedIds,[]);
});

test('an added event is a busy block of my day, friends see only its minutes, and removing it frees the time',async()=>{
 await db.doc('andesEvents/feria').set(event());
 await db.doc('availability/alice/days/2026-11-25').set({busy:[{start:480,end:600},{start:900,end:960}],updatedAt:Timestamp.fromDate(NOW)});
 const added=await call('addAndesEventToSchedule',{eventId:'feria'});
 assert.deepEqual(added,{added:true,alreadyAdded:false,date:'2026-11-25'});
 assert.deepEqual((await call('getAndesEvents')).addedIds,['feria']);
 const mine=(await call('getScheduleDay',{date:'2026-11-25',friendIds:[]})).schedules[0];
 // 2 PM to 4 PM joins the 3 PM to 4 PM calendar block
 assert.deepEqual(mine.busy,[{start:480,end:600},{start:840,end:960}]);assert.equal(mine.known,true);
 const seenByBob=(await call('getScheduleDay',{date:'2026-11-25',friendIds:['alice']},'bob')).schedules[1];
 assert.deepEqual(seenByBob.busy,[{start:480,end:600},{start:840,end:960}]);
 assert.deepEqual(Object.keys(seenByBob).sort(),['busy','known','ownerId','updatedAt']);
 // importing the calendar again rewrites availability, the event stays
 await db.doc('availability/alice/days/2026-11-25').set({busy:[],updatedAt:Timestamp.fromDate(NOW)});
 assert.deepEqual((await call('getScheduleDay',{date:'2026-11-25',friendIds:[]})).schedules[0].busy,[{start:840,end:960}]);
 await call('removeAndesEventFromSchedule',{eventId:'feria'});
 assert.deepEqual((await call('getScheduleDay',{date:'2026-11-25',friendIds:[]})).schedules[0].busy,[]);
 assert.deepEqual((await call('getAndesEvents')).addedIds,[]);
});

test('adding twice is fine, and a missing, ended or changed event is refused',async()=>{
 await db.doc('andesEvents/feria').set(event());
 const shown={eventId:'feria',start:bogota(25,14).toISOString(),end:bogota(25,16).toISOString(),location:'Edificio Santo Domingo'};
 assert.equal((await call('addAndesEventToSchedule',shown)).alreadyAdded,false);
 assert.equal((await call('addAndesEventToSchedule',shown)).alreadyAdded,true);
 await failure(call('addAndesEventToSchedule',{eventId:'nope'}),'not-found');
 await db.doc('andesEvents/old').set(event({start:Timestamp.fromDate(bogota(25,7)),end:Timestamp.fromDate(bogota(25,8))}));
 await failure(call('addAndesEventToSchedule',{eventId:'old'}),'failed-precondition');
 await db.doc('andesEvents/moved').set(event({location:'Auditorio Lleras'}));
 await failure(call('addAndesEventToSchedule',{...shown,eventId:'moved'}),'failed-precondition');
 await failure(call('addAndesEventToSchedule',{eventId:'moved',start:shown.start}),'invalid-argument');
 // an offline add sent later by another account is refused before reaching the schedule
 await failure(call('addAndesEventToSchedule',{eventId:'feria',clientUserId:'bob'}),'permission-denied');
 await failure(call('getAndesEvents',{},null),'unauthenticated');
});

test('a phone can not read or write the Andes Events added to Schedule directly',async()=>{
 const rules=require('node:fs').readFileSync(require.resolve('../firestore.rules'),'utf8');
 assert.match(rules,/match \/andesSchedule\/\{userId\}\/\{document=\*\*\} \{ allow read, write: if false; \}/);
});
