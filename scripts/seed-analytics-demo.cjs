// Disposable dashboard QA fixtures. Fixed demo project + loopback emulators only.
const assert=require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
const {createRequire}=require('node:module');
const req=createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getFirestore}=req('firebase-admin/firestore');
const {getAuth}=req('firebase-admin/auth');
const {localDate,dayStart}=require('../functions/src/availability');
const {refreshActivityInsights}=require('../functions/src/activityInsights');
const project='demo-parchapp-analytics';
const app=initializeApp({projectId:project},'analytics-demo');
const db=getFirestore(app),auth=getAuth(app),now=new Date(),DAY=86400000;
const writes=[];
const put=(path,data)=>writes.push([db.doc(path),data]);
async function main(){
  try{await auth.getUser('analytics-qa');}catch(error){if(error.code!=='auth/user-not-found')throw error;
    await auth.createUser({uid:'analytics-qa',email:'dashboard.qa@example.test',password:'LocalOnly-Analytics-2026!'});}
  await auth.setCustomUserClaims('analytics-qa',{orgAnalytics:true});
  for(let day=0;day<28;day++){
    const anchor=new Date(Math.min(dayStart(localDate(new Date(+now-day*DAY)))+12*3600000,+now-60000));
    for(let j=0;j<16;j++){
      const outcome=(j+day)%13===0?'timeout':(j+day)%9===0?'failure':j===15?'unresolved':'success';
      put(`creationAttempts/qa-attempt-${day}-${j}`,{uid:'qa-source',attemptId:`qa-${day}-${j}`,requestId:`qa-request-${day}-${j}`,
        startedAt:anchor,environment:'test',platform:'flutter',...(outcome==='unresolved'?{}:{outcome,durationMs:outcome==='timeout'?8000:200+(j*137+day*41)%6000}),
        errorCode:outcome==='failure'?j%2?'unavailable':'permission-denied':null,
        ...(outcome==='timeout'&&day%2===0?{remoteOutcome:'success'}:{})});
    }
    const category=['study','sports','social'][day%3],groupSize=[3,5,8][day%3];
    for(let position=0;position<3;position++){
      put(`slotRecommendations/qa-candidate-${day}-${position}`,{activityId:`qa-activity-${day}`,batchId:`qa-batch-${day}`,
        schemaVersion:2,groupSize,category,position,presentedAt:anchor,batchPresentedAt:anchor,environment:'test',
        startTime:new Date(+anchor+3*3600000).toISOString(),endTime:new Date(+anchor+4*3600000).toISOString(),
        outcome:position===day%3?(day%4===0?'MODIFIED':'ACCEPTED_UNCHANGED'):'NOT_SELECTED',decidedAt:new Date(+anchor+60000)});
    }
    for(const size of [3,5,8])for(const delay of [30,60])for(let j=0;j<2;j++){
      const id=`qa-reminder-${day}-${size}-${delay}-${j}`,strategy=`single_after_${delay}_min`;
      const confirmed=(day+j)%(delay===30?5:4)!==0;
      put(`reminderMeasurements/${id}`,{invitedAt:anchor,groupSize:size,strategy,environment:'test',initiallyConfirmed:false});
      put(`coordinationMeasurements/${id}`,{firstConfirmedAt:confirmed?new Date(+anchor+(delay+15+(day%5)*4)*60000):null});
      put(`activities/${id}`,{createdBy:'qa-source',createdAt:anchor,category:'study',cancelled:false});
      if(day>0)put(`reminderDeliveries/${id}`,{activityId:id,recipientId:'qa-recipient',strategy,sequence:1,purpose:'rsvp',
        environment:'test',channel:'in-app',sentAt:new Date(+anchor+delay*60000)});
    }
  }
  put('slotRecommendations/qa-legacy',{presentedAt:new Date(+now-3*DAY),environment:'test',outcome:'MODIFIED'});
  for(let i=0;i<writes.length;i+=400){const batch=db.batch();for(const [ref,data]of writes.slice(i,i+400))batch.set(ref,data);await batch.commit();}
  const result=await refreshActivityInsights(db,now);
  console.log(JSON.stringify({project,fixture:true,written:writes.length,...result}));
}
main().finally(async()=>{await db.terminate();await deleteApp(app);}).catch(error=>{console.error(error.message);process.exitCode=1;});
