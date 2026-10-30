const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail('gabriel.ropinto@gmail.com');
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token,account.tokens.scopes);
  async function get(url) {
    const response = await fetch(url,{headers:{Authorization:`Bearer ${access_token}`},signal:AbortSignal.timeout(30000)});
    return {http:response.status,body:await response.json()};
  }
  const [provider,keys,services,sha] = await Promise.all([
    get('https://identitytoolkit.googleapis.com/admin/v2/projects/parchapp-ee6cc/defaultSupportedIdpConfigs/google.com'),
    get('https://apikeys.googleapis.com/v2/projects/718308941728/locations/global/keys'),
    get('https://serviceusage.googleapis.com/v1/projects/718308941728/services?filter=state:ENABLED&pageSize=200'),
    get('https://firebase.googleapis.com/v1beta1/projects/parchapp-ee6cc/androidApps/1:718308941728:android:117a10f675ea5500998ec5/sha'),
  ]);
  const report={checkedAt:new Date().toISOString(),project:'parchapp-ee6cc',
    googleProvider:{http:provider.http,enabled:provider.body.enabled,clientId:provider.body.clientId},
    apiKeys:{http:keys.http,keys:(keys.body.keys||[]).map(k=>({name:k.name,displayName:k.displayName,restrictions:k.restrictions||null}))},
    mapsServices:{http:services.http,enabled:(services.body.services||[]).filter(s=>/maps|places|geocod/i.test(s.config?.name||'')).map(s=>s.config.name),more:Boolean(services.body.nextPageToken)},
    androidCertificates:{http:sha.http,certificates:(sha.body.certificates||[]).map(c=>({type:c.certType,hash:c.shaHash}))}};
  fs.writeFileSync(path.join(__dirname,'../docs/google-integrations-audit.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Google integration audit failed; no credentials printed.');process.exitCode=1;});
