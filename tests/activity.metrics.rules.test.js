const test=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,updateDoc}=require('firebase/firestore');
let env;
test.before(async()=>{
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Emulator required');
  env=await initializeTestEnvironment({projectId:'demo-parchapp-activity-rules',
    firestore:{rules:fs.readFileSync(path.join(__dirname,'../firestore.rules'),'utf8')}});
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    await setDoc(doc(db,'groups/g'),{memberIds:['owner','peer']});
    await setDoc(doc(db,'activities/a'),{createdBy:'owner',groupId:'g',title:'QA',status:'PROPOSED'});
    await setDoc(doc(db,'insights/bq2_creation_reliability'),{attempts:0});
    await setDoc(doc(db,'creationAttempts/a'),{uid:'owner'});
  });
});
test.after(async()=>{await env?.cleanup();});
test('metrics are read-only to authenticated dashboard, raw attempts are server-owned',async()=>{
  const owner=env.authenticatedContext('owner',{orgAnalytics:true}).firestore(),anon=env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(owner,'insights/bq2_creation_reliability')));
  await assertFails(getDoc(doc(env.authenticatedContext('app-user').firestore(),'insights/bq2_creation_reliability')));
  await assertFails(getDoc(doc(anon,'insights/bq2_creation_reliability')));
  await assertFails(setDoc(doc(owner,'insights/bq2_creation_reliability'),{attempts:100}));
  await assertFails(getDoc(doc(owner,'creationAttempts/a')));
  await assertFails(setDoc(doc(owner,'creationAttempts/forged'),{uid:'owner',outcome:'success'}));
  for(const collection of ['usernames','publicPeople','friendships','reminderMeasurements','reminderDeliveries']) {
    await assertFails(setDoc(doc(owner,`${collection}/forged`),{uid:'owner'}));
    await assertFails(getDoc(doc(owner,`${collection}/forged`)));
  }
});
test('legacy Java confirmation stays allowed but attribution snapshots cannot be forged',async()=>{
  const owner=env.authenticatedContext('owner').firestore(),peer=env.authenticatedContext('peer').firestore();
  await assertSucceeds(updateDoc(doc(owner,'activities/a'),{status:'CONFIRMED'}));
  await assertFails(updateDoc(doc(peer,'activities/a'),{status:'CONFIRMED'}));
  await assertFails(updateDoc(doc(owner,'activities/a'),{recommendationAttribution:{candidateId:'fake'}}));
  await assertFails(setDoc(doc(owner,'coordinationMeasurements/a'),{firstConfirmedAt:new Date()}));
});
