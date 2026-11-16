const test=require('node:test');
const assert=require('node:assert/strict');
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
const req=require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp,deleteApp}=req('firebase-admin/app');
const {getAuth}=req('firebase-admin/auth');
test('Auth emulator creates a usable recovery code without verifying or changing the account',async()=>{
 const project='demo-parchapp-phase-d-auth',app=initializeApp({projectId:project},'phase-d-auth-test'),auth=getAuth(app);
 const uid=`reset-${Date.now()}`,email=`${uid}@test.example`;
 try{
  await auth.createUser({uid,email,password:'Local-only-123!',emailVerified:false});
  // Same emulator recovery operation used by client email requests, with the
  // admin return-link variant so the test can verify the code without mail.
  const link=await auth.generatePasswordResetLink(email);
  const code=new URL(link).searchParams.get('oobCode');assert.ok(code);
  const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=emulator',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer owner'},body:JSON.stringify({oobCode:code,targetProjectId:project})});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.email,email);assert.equal(result.requestType,'PASSWORD_RESET');
  assert.equal((await auth.getUser(uid)).emailVerified,false);
 }finally{try{await auth.deleteUser(uid);}finally{await deleteApp(app);}}
});
