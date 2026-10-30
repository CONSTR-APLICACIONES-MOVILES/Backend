// Local-only HTTP/Auth social workflow + server-clock-controlled reminder cohorts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app'),{getFirestore}=req('firebase-admin/firestore');
const project='demo-parchapp-activity-metrics';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
async function post(url,data,token){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(60000)});return{status:r.status,body:await r.json()};}
async function account(email){const endpoint='http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:';
  const input={email,password:'MetricsQa123!',returnSecureToken:true};let r=await post(`${endpoint}signUp?key=emulator`,input);
  if(r.status!==200)r=await post(`${endpoint}signInWithPassword?key=emulator`,input);assert.equal(r.status,200);return r.body;}
(async()=>{
  const app=initializeApp({projectId:project},'social-http'),db=getFirestore(app);
  try{
    const auth=req('firebase-admin/auth').getAuth(app);
    try{await auth.getUser('local-test-social-peer');}catch(e){
      if(e.code!=='auth/user-not-found')throw e;
      await auth.createUser({uid:'local-test-social-peer',email:'social.peer@example.test',password:'MetricsQa123!'});
    }
    const owner=await account('metrics.owner@example.test'),outsider=await account('social.peer@example.test');
    const adminAuth=req('firebase-admin/auth').getAuth(app);
    await adminAuth.setCustomUserClaims(owner.localId,{orgAnalytics:true});
    owner.idToken=(await account('metrics.owner@example.test')).idToken;

    assert.equal(outsider.localId,'local-test-social-peer');
    const call=async(name,data={},who=owner,status=200)=>{const r=await post(`http://127.0.0.1:5001/${project}/us-central1/${name}`,{data},who?.idToken);assert.equal(r.status,status,`${name}: ${JSON.stringify(r.body)}`);return r.body.result??r.body.data;};
    await call('setUsername',{username:'activity.qa'});await call('setUsername',{username:'friend.qa'},outsider);
    await call('setUsername',{username:'activity.qa'},outsider,409);
    const search=await call('searchPeople',{query:'friend.'});assert.equal(search.people[0].id,outsider.localId);
    const person=await call('getPublicPerson',{userId:outsider.localId});
    const sent=await call('changeFriendship',{userId:outsider.localId,action:'request',expectedVersion:person.friendship.version});
    const accepted=await call('changeFriendship',{userId:owner.localId,action:'accept',expectedVersion:sent.version},outsider);
    assert.ok((await call('getFriends')).relationships.some(r=>r.person.id===outsider.localId&&r.state==='accepted'));
    assert.equal((await call('getScheduleFriends',{},outsider)).friends.length,0,'Friendship must not expose schedules');
    const share=await call('createShareLink',{requestId:`social-code-${Date.now()}`,kind:'profile',entityId:owner.localId,hours:1,clientUserId:owner.localId});
    const preview=await call('resolveShareLink',{token:share.token},outsider);assert.equal(preview.kind,'profile');
    await call('changeFriendship',{userId:outsider.localId,action:'remove',expectedVersion:accepted.version});
    assert.equal((await call('getFriends',{},outsider)).relationships.length,0);

    const {MobileService}=require('../functions/src/mobileService'),{ActivityService}=require('../functions/src/activityService');
    const {ActivityRepository}=require('../functions/src/activityRepository');
    const {chooseReminderPolicy,dispatchPendingReminders}=require('../functions/src/reminderInsights');
    let clock=new Date(Date.now()-2*86400000);clock.setUTCHours(13,0,0,0);const anchor=+clock;
    const service=new MobileService(db,{clock:()=>clock}),activity=new ActivityService(new ActivityRepository(db),{clock:()=>clock});
    const day=new Date(anchor-5*3600000).toISOString().slice(0,10),cohort=[];
    for(const delay of [30,60]){
      const strategy=`single_after_${delay}_min`;let requestId;
      for(let i=0;i<200;i++){
        const id=`bq14-fixture-${delay}-${i}`,activityId=`mobile-${createHash('sha256').update(JSON.stringify([owner.localId,id])).digest('hex').slice(0,40)}`;
        if(chooseReminderPolicy(activityId,2,clock,null,'test').strategy===strategy){requestId=id;break;}
      }
      const created=await service.publishActivity(owner.localId,{measurementVersion:1,requestId,groupId:'metrics-qa',fields:{title:`BQ14 ${delay} minute fixture`,status:'PROPOSED'},
        startTime:`${day}T20:00:00Z`,endTime:`${day}T21:00:00Z`,timeZone:'America/Bogota'});
      cohort.push({...created,delay});
    }
    clock=new Date(anchor+31*60000);await Promise.all([dispatchPendingReminders(db,clock),dispatchPendingReminders(db,clock)]);
    async function confirm(row,minutes){clock=new Date(anchor+minutes*60000);const d=await activity.getActivity(owner.localId,{activityId:row.activityId});
      await service.updateActivityDetails(owner.localId,{activityId:row.activityId,expectedVersion:d.version,fields:{title:d.title,status:'CONFIRMED',category:d.category,date:d.date,time:d.time,location:d.location}});}
    await confirm(cohort[0],45);clock=new Date(anchor+61*60000);await dispatchPendingReminders(db,clock);await confirm(cohort[1],90);
    await call('refreshActivityInsights');
    const insight=(await db.doc('insights/bq14_reminder_effectiveness').get()).data();
    assert.equal(insight.environment,'test');assert.ok(insight.mature_activities>=2);assert.ok(insight.decisions.every(d=>!d.sufficient));
    const report={checkedAt:new Date().toISOString(),project,result:'PASS',
      social:'Username collision, no-shared-group discovery, request/accept/remove, public profile code, no automatic schedule access',
      reminders:'Real server dispatcher with injected clock, two strategies, concurrent retry, in-app only',
      policies:cohort.map(r=>({activityId:r.activityId,delay:r.delay})),rows:insight.by_strategy_size};
    fs.writeFileSync(path.join(__dirname,'../tmp/social-reminders-http.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await db.terminate();await deleteApp(app);}
})().catch(e=>{console.error(e);process.exitCode=1;});
