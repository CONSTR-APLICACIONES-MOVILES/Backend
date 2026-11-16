const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail(process.env.FIREBASE_ACCOUNT || (() => { throw new Error('Set FIREBASE_ACCOUNT to the Firebase account email.'); })());
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token, account.tokens.scopes);
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/firebase-live-source-metadata.json')));
  const source = metadata.find(f => f.id === 'refreshTeamInsights').source.storageSource;
  const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${source.bucket}/o/${encodeURIComponent(source.object)}?alt=media&generation=${source.generation}`, {headers:{Authorization:`Bearer ${access_token}`}});
  if (!response.ok) throw new Error(`Source download HTTP ${response.status}`);
  const dir = path.join(__dirname, '../tmp/deployed-team');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'source.zip'), Buffer.from(await response.arrayBuffer()));
  console.log('Saved deployed team source snapshot to tmp/deployed-team/source.zip');
}
main().catch(e => { console.error(e.message); process.exitCode=1; });
