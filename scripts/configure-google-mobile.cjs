// Provision only the Google mobile integration requested for parchapp-ee6cc.
// API key strings are written to ignored local build configuration, never printed.
const fs=require('node:fs');
const path=require('node:path');
const project='parchapp-ee6cc',number='718308941728';
const appId='1:718308941728:android:117a10f675ea5500998ec5';
const sha1='2E318395E9F6B55BD5B70F201BDE7241A27DC0D7';
const sha256='741EBD5165EDC732EEA2DE4ABF258CFBDCFC3E9D143CBDA762A797DDDA257B09';
const services=['maps-android-backend.googleapis.com','places.googleapis.com'];
const restrictions={androidKeyRestrictions:{allowedApplications:[
  {packageName:'com.example.parchapp',sha1Fingerprint:sha1},
  {packageName:'com.example.parchapp',sha1Fingerprint:'6332F769D4B570EFE03CF600F9F6114DE603B573'},
]},apiTargets:services.map(service=>({service}))};
const plan={project,androidPackage:'com.example.parchapp',registerCertificates:[{certType:'SHA_1',shaHash:sha1},{certType:'SHA_256',shaHash:sha256}],
  enableServices:services,keyId:'parchapp-android-maps',restrictions};
async function main(){
  if(!process.argv.includes('--apply')){console.log(JSON.stringify(plan,null,2));return;}
  const auth=require('firebase-tools/lib/auth');
  const account=auth.findAccountByEmail(process.env.FIREBASE_ACCOUNT || (() => { throw new Error('Set FIREBASE_ACCOUNT to the Firebase account email.'); })());
  const {access_token}=await auth.getAccessToken(account.tokens.refresh_token,account.tokens.scopes);
  async function request(url,method='GET',data,allow404=false){
    const r=await fetch(url,{method,headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});
    const b=await r.json();
    if(allow404&&r.status===404)return null;
    if(!r.ok)throw Error(`Google configuration HTTP ${r.status}: ${b.error?.status||'request failed'}`);
    return b;
  }
  async function wait(base,operation){
    let current=operation;
    for(let i=0;i<45&&!current.done;i++){
      await new Promise(resolve=>setTimeout(resolve,1500));
      current=await request(`${base}/${operation.name}`);
    }
    if(current.error)throw Error(`Google operation failed: ${current.error.code}`);
    if(!current.done)throw Error('Google operation is still pending; rerun after it finishes.');
    return current.response;
  }
  const certRoot=`https://firebase.googleapis.com/v1beta1/projects/${project}/androidApps/${appId}/sha`;
  const existing=await request(certRoot);
  for(const certificate of plan.registerCertificates){
    if(!(existing.certificates||[]).some(c=>c.shaHash?.replaceAll(':','').toUpperCase()===certificate.shaHash)){
      await request(certRoot,'POST',certificate);
    }
  }
  console.log('Android signing certificates registered.');
  const enabled=await request(`https://serviceusage.googleapis.com/v1/projects/${number}/services:batchEnable`,'POST',{serviceIds:services});
  await wait('https://serviceusage.googleapis.com/v1',enabled);
  console.log('Maps SDK for Android and Places API enabled.');
  const root=`https://apikeys.googleapis.com/v2/projects/${number}/locations/global/keys`;
  const listed=await request(root);
  let key=(listed.keys||[]).find(k=>k.name.endsWith('/parchapp-android-maps')||k.displayName==='ParchApp Android Maps');
  if(!key){
    const created=await request(`${root}?keyId=parchapp-android-maps`,'POST',{displayName:'ParchApp Android Maps',restrictions});
    key=await wait('https://apikeys.googleapis.com/v2',created);
  }else if(JSON.stringify(key.restrictions)!==JSON.stringify(restrictions)){
    throw Error('An existing Maps key has different restrictions; it was not modified.');
  }
  const keyString=(await request(`https://apikeys.googleapis.com/v2/${key.name}/keyString`)).keyString;
  if(!keyString)throw Error('Maps key value was not returned.');
  const flutterRoot=path.resolve(__dirname,'../../Sprint-2/ParchApp-Flutter');
  fs.writeFileSync(path.join(flutterRoot,'android/maps.properties'),`GOOGLE_MAPS_API_KEY=${keyString}\n`);
  const config=await request(`https://firebase.googleapis.com/v1beta1/projects/${project}/androidApps/${appId}/config`);
  const json=JSON.parse(Buffer.from(config.configFileContents,'base64').toString('utf8'));
  if(json.project_info?.project_id!==project)throw Error('Unexpected Firebase project in Android config.');
  fs.writeFileSync(path.join(flutterRoot,'android/app/google-services.json'),JSON.stringify(json,null,2)+'\n');
  const oauthCertificatePresent=(json.client||[]).flatMap(c=>c.oauth_client||[]).some(c=>c.android_info?.certificate_hash?.toUpperCase()===sha1);
  const report={checkedAt:new Date().toISOString(),...plan,keyResource:key.name,localKeyFile:'android/maps.properties (ignored)',
    firebaseConfigRefreshed:true,oauthCertificatePresent};
  fs.writeFileSync(path.join(__dirname,'../docs/google-mobile-configuration.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
