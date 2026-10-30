const fs=require('node:fs');
const path=require('node:path');
async function main(){
  const auth=require('firebase-tools/lib/auth');
  const a=auth.findAccountByEmail(process.env.FIREBASE_ACCOUNT || (() => { throw new Error('Set FIREBASE_ACCOUNT to the Firebase account email.'); })());
  const {access_token}=await auth.getAccessToken(a.tokens.refresh_token,a.tokens.scopes);
  const headers={Authorization:`Bearer ${access_token}`};
  const appId='1:718308941728:web:abbff5e172d045a7998ec5';
  const response=await fetch(`https://firebase.googleapis.com/v1beta1/projects/parchapp-ee6cc/webApps/${appId}/config`,{headers});
  const config=await response.json();
  if(!response.ok||config.projectId!=='parchapp-ee6cc')throw Error('Unable to verify the current web Firebase app.');
  const root=path.resolve(__dirname,'../../Sprint-2/ParchApp-Flutter');
  const file=path.join(root,'lib/firebase_options.dart');
  const source=fs.readFileSync(file,'utf8');
  const keys=['apiKey','appId','messagingSenderId','projectId','authDomain','storageBucket','measurementId'];
  const fields=keys.filter(key=>config[key]).map(key=>`    ${key}: '${config[key]}',`).join('\n');
  const next=source.replace(/  static const FirebaseOptions web = FirebaseOptions\([\s\S]*?\n  \);/,`  static const FirebaseOptions web = FirebaseOptions(\n${fields}\n  );`);
  if(next===source)throw Error('Web options were not updated.');
  fs.writeFileSync(file,next);
  const metadataFile=path.join(root,'firebase.json');
  const metadata=JSON.parse(fs.readFileSync(metadataFile,'utf8'));
  metadata.flutter.platforms.dart['lib/firebase_options.dart'].configurations.web=appId;
  fs.writeFileSync(metadataFile,JSON.stringify(metadata,null,2)+'\n');
  const settingsResponse=await fetch('https://identitytoolkit.googleapis.com/admin/v2/projects/parchapp-ee6cc/config',{headers});
  const settings=await settingsResponse.json();
  console.log(JSON.stringify({project:config.projectId,webAppId:config.appId,authDomain:config.authDomain,
    authorizedDomains:settings.authorizedDomains||[],configurationUpdated:true}));
}
main().catch(()=>{console.error('Web Firebase configuration refresh failed; no credentials printed.');process.exitCode=1;});
