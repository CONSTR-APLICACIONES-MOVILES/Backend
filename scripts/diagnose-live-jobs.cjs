const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail('gabriel.ropinto@gmail.com');
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token,account.tokens.scopes);
  const headers = {Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'};
  const response = await fetch('https://cloudscheduler.googleapis.com/v1/projects/parchapp-ee6cc/locations/us-central1/jobs',{headers});
  const body = await response.json();
  const jobs = (body.jobs || []).filter(j => j.name.includes('refreshCoordinationInsight') || j.name.includes('refreshTeamInsightsNightly'))
    .map(j => ({name:j.name,uri:j.httpTarget?.uri,invoker:j.httpTarget?.oidcToken?.serviceAccountEmail,
      state:j.state,lastAttempt:j.lastAttemptTime,status:j.status}));
  const logs = await fetch('https://logging.googleapis.com/v2/entries:list',{method:'POST',headers,body:JSON.stringify({
    resourceNames:['projects/parchapp-ee6cc'],
    filter:'resource.type="cloud_run_revision" AND resource.labels.service_name="refreshteaminsightsnightly" AND severity>=ERROR AND timestamp>="2026-10-29T21:48:30Z"',
    pageSize:10,orderBy:'timestamp desc'})});
  const entries = await logs.json();
  const report={checkedAt:new Date().toISOString(),schedulerHttp:response.status,jobs,logHttp:logs.status,
    errors:(entries.entries || []).map(e => ({severity:e.severity,message:(e.textPayload || e.jsonPayload?.message || `HTTP ${e.httpRequest?.status}`).slice(0,600)}))};
  fs.writeFileSync(path.join(__dirname,'../docs/firebase-live-job-diagnostic.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(() => {console.error('Job diagnosis failed; no credentials printed.');process.exitCode=1;});
