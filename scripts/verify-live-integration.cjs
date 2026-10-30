// Verify deployment and, when explicitly requested, run the approved team aggregation job once.
// Credentials stay in memory; only deployment metadata and aggregate counts are persisted.
const fs = require('node:fs');
const path = require('node:path');
const project = 'parchapp-ee6cc';
const targets = ['getCoordinationInsight','prepareProposalComparison','validatePlanningSlot','publishActivity',
  'updateActivityDetails','recordFirstActivityConfirmation','refreshCoordinationInsight','refreshResponseTimeInsight',
  'refreshTeamInsights','refreshTeamInsightsNightly'];
async function main() {
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail('gabriel.ropinto@gmail.com');
  if (!account) throw new Error('Expected Firebase CLI account is not logged in.');
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token,account.tokens.scopes);
  async function request(url,method='GET',body) {
    const response = await fetch(url,{method,headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(30000)});
    const result = await response.json();
    if (!response.ok) throw new Error(`Cloud API HTTP ${response.status}: ${result.error?.status || 'request failed'}`);
    return result;
  }
  const listing = await request(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/us-central1/functions?pageSize=1000`);
  const functions = listing.functions || [];
  const deployment = targets.map(name => {
    const entry = functions.find(f => f.name.endsWith(`/${name}`));
    return {name,state:entry?.state || 'MISSING',updatedAt:entry?.updateTime,
      legacyDataset:entry?.serviceConfig?.environmentVariables?.ANALYTICS_DATASET || null,
      persistentRetries:entry?.eventTrigger?.retryPolicy === 'RETRY_POLICY_RETRY'};
  });
  const schedulerRoot = `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/us-central1/jobs`;
  const jobs = (await request(schedulerRoot)).jobs || [];
  const teamJob = jobs.find(j => j.name.endsWith('/firebase-schedule-refreshTeamInsightsNightly-us-central1'));
  let refresh = null;
  if (process.argv.includes('--refresh')) {
    if (!teamJob || deployment.some(f => f.state !== 'ACTIVE')) throw new Error('Deployment or team job is not ready.');
    const result = await request(`https://cloudscheduler.googleapis.com/v1/${teamJob.name}:run`,'POST',{});
    refresh = {job:result.name,requestedAt:new Date().toISOString()};
  }
  const endpoints = [];
  for (const name of ['getCoordinationInsight','prepareProposalComparison']) {
    const response = await fetch(`https://us-central1-${project}.cloudfunctions.net/${name}`,
      {method:'POST',headers:{'Content-Type':'application/json'},body:'{"data":{}}',signal:AbortSignal.timeout(30000)});
    const body = await response.json().catch(() => ({}));
    endpoints.push({name,http:response.status,error:body.error?.status || null});
  }
  const aggregates = [];
  for (const name of ['bq1_engine_latency','bq8_feature_usage','bq5_response_time','bq9_comparison_confirmation']) {
    const response = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/insights/${name}`,
      {headers:{Authorization:`Bearer ${access_token}`},signal:AbortSignal.timeout(30000)});
    const doc = await response.json();
    const field = key => {const v=doc.fields?.[key]; return v?.stringValue ?? v?.integerValue ?? v?.doubleValue ?? v?.timestampValue ?? null;};
    aggregates.push({name,http:response.status,updatedAt:field('updatedAt') || field('updated_at'),
      total:field('total'),known:field('known'),unknown:field('unknown'),source:field('source'),
      environment:field('environment'),invitations:field('invitations')});
  }
  const report={checkedAt:new Date().toISOString(),project,deployment,refresh,endpoints,aggregates,
    job:teamJob ? {name:teamJob.name,lastAttemptTime:teamJob.lastAttemptTime,status:teamJob.status || null} : null};
  fs.writeFileSync(path.join(__dirname,'../docs/firebase-live-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if (deployment.some(f => f.state !== 'ACTIVE') || endpoints.some(e => e.http!==401 || e.error!=='UNAUTHENTICATED')) process.exitCode=1;
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
