const test=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc}=require('firebase/firestore');
let env;
test.before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-parchapp-phase-d-rules',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync(path.join(__dirname,'..','firestore.rules'),'utf8')}});
 await env.withSecurityRulesDisabled(async context=>{
  const db=context.firestore();
  for(const address of ['shareLinks/link','shareCommands/owner/requests/request','activityMaterials/a1','activityMaterials/a1/checks/owner','alertEvents/owner/items/event','calendarImports/owner'])await setDoc(doc(db,address),{ownerId:'owner',secret:'server-only'});
 });
});
test.after(async()=>env?.cleanup());
test('tokens, receipts, resources, personal checks, event delivery and import evidence are callable-only',async()=>{
 const db=env.authenticatedContext('owner').firestore();
 for(const address of ['shareLinks/link','shareCommands/owner/requests/request','activityMaterials/a1','activityMaterials/a1/checks/owner','alertEvents/owner/items/event','calendarImports/owner']){
  await assertFails(getDoc(doc(db,address)));await assertFails(setDoc(doc(db,address),{forged:true}));
 }
});
