// Read-only audit. Uses the selected Firebase CLI session in memory; never prints tokens.
const fs = require('node:fs');
const path = require('node:path');
const auth = require('firebase-tools/lib/auth');
const project = 'parchapp-ee6cc';
const accountEmail = process.argv[2];
async function main() {
  if (!accountEmail) throw new Error('Pass the Firebase CLI account email.');
  const account = auth.findAccountByEmail(accountEmail);
  if (!account) throw new Error('Account is not logged in to Firebase CLI.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, account.tokens.scopes);
  const token = credentials.access_token;
  if (!token) throw new Error('No access token returned.');
  async function read(url, summarize) {
    const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(30000)});
    const body = await response.json();
    return {http: response.status, ...(response.ok ? summarize(body) : {error: body.error?.status || 'Request failed'})};
  }
  const [databases, analytics, authentication] = await Promise.all([
    read(`https://firestore.googleapis.com/v1/projects/${project}/databases`, b => ({databases: (b.databases || []).map(d => ({name:d.name, location:d.locationId, type:d.type}))})),
    read(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets?all=true&maxResults=1000`, b => ({datasets: (b.datasets || []).map(d => d.datasetReference.datasetId), more: Boolean(b.nextPageToken)})),
    read(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`, b => ({emailPasswordEnabled:b.signIn?.email?.enabled, passwordRequired:b.signIn?.email?.passwordRequired, anonymousEnabled:b.signIn?.anonymous?.enabled})),
  ]);
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/firebase-live-functions.json'), 'utf8'));
  const deployed = new Set(inventory.filter(f => f.callable).map(f => f.name));
  const root = path.join(__dirname, '../../Sprint-2/ParchApp-Flutter/lib');
  const calls = new Set();
  function scan(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (file.endsWith('.dart')) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/(?:\.call|\.httpsCallable)\s*(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g)) calls.add(match[1]);
      }
    }
  }
  scan(root);
  const report = {checkedAt:new Date().toISOString(), project, databases, analytics, authentication,
    functions: {count:inventory.length, clientCalls:[...calls].sort(), missingClientCalls:[...calls].filter(n => !deployed.has(n)).sort()},
    limits:['Function presence is not an authenticated end-to-end test.', 'Call scan finds string literals only.', 'No business documents were read or written.']};
  fs.writeFileSync(path.join(__dirname, '../docs/firebase-live-audit.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(() => { console.error('Live audit failed; no credentials printed. Verify account permissions and connectivity.'); process.exitCode=1; });
