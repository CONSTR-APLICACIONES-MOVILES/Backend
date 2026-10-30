const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail(process.env.FIREBASE_ACCOUNT || (() => { throw new Error('Set FIREBASE_ACCOUNT to the Firebase account email.'); })());
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token,account.tokens.scopes);
  const headers={Authorization:`Bearer ${access_token}`};
  async function read(url) {
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
    return {http:response.status,body:await response.json()};
  }
  const [hosting,groups,releases]=await Promise.all([
    read('https://firebasehosting.googleapis.com/v1beta1/projects/parchapp-ee6cc/sites'),
    read('https://firebaseappdistribution.googleapis.com/v1/projects/718308941728/groups'),
    read('https://firebaseappdistribution.googleapis.com/v1/projects/718308941728/apps/1:718308941728:android:117a10f675ea5500998ec5/releases?pageSize=10'),
  ]);
  const sites=[];
  for (const site of hosting.body.sites || []) {
    if (!site.defaultUrl) continue;
    const response=await fetch(site.defaultUrl,{signal:AbortSignal.timeout(20000)});
    const html=await response.text();
    sites.push({name:site.name,url:site.defaultUrl,http:response.status,
      isParchApp:/parchapp/i.test(html),hasBq9:/bq9|bq9_comparison_confirmation|Comparison.*confirmation/i.test(html),
      insightDocuments:[...new Set(html.match(/bq\d+_[a-z_]+/g)||[])]});
  }
  const report={checkedAt:new Date().toISOString(),project:'parchapp-ee6cc',hosting:{http:hosting.http,sites},
    distribution:{groupsHttp:groups.http,groupCount:(groups.body.groups||[]).length,releasesHttp:releases.http,
      releases:(releases.body.releases||[]).map(r=>({displayVersion:r.displayVersion,buildVersion:r.buildVersion,createTime:r.createTime}))},
    limits:['HTTP reachability does not prove authenticated dashboard access.', 'No tester identities read; course TA roster not checked.']};
  fs.writeFileSync(path.join(__dirname,'../docs/firebase-delivery-access.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Delivery access audit failed; no credentials printed.');process.exitCode=1;});
