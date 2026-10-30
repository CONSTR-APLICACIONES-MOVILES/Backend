// Targeted repair: preview by default; only legacy sample group arrays are updated.
const {demoGroups} = require('../functions/src/demoData');
async function main() {
  const email = process.argv.find(a => a.startsWith('--email='))?.slice(8);
  if (!email) throw Error('Supply --email=<account>');
  const auth = require('firebase-tools/lib/auth');
  const account = auth.findAccountByEmail(process.env.FIREBASE_ACCOUNT || (() => { throw new Error('Set FIREBASE_ACCOUNT to the Firebase account email.'); })());
  const {access_token} = await auth.getAccessToken(account.tokens.refresh_token, account.tokens.scopes);
  const project = 'parchapp-ee6cc';
  async function request(url, method = 'GET', body) {
    const response = await fetch(url, {method, headers: {Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30000)});
    const data = await response.json();
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`Repair request HTTP ${response.status}: ${data.error?.status || 'failed'}`);
    return data;
  }
  const lookup = await request(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`, 'POST', {email: [email]});
  if (lookup.users?.length !== 1 || lookup.users[0].email.toLowerCase() !== email.toLowerCase()) throw Error('Account not uniquely verified');
  const uid = lookup.users[0].localId;
  const root = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  // Preserve access to any real activity this account already organized in sample groups.
  const activities = await request(`${root}:runQuery`, 'POST', {structuredQuery: {from: [{collectionId: 'activities'}],
    where: {fieldFilter: {field: {fieldPath: 'createdBy'}, op: 'EQUAL', value: {stringValue: uid}}}}});
  const ownedGroups = new Set(activities.filter(r => r.document).map(r => r.document.fields?.groupId?.stringValue));
  const writes = [], groups = [], skipped = [];
  for (const id of Object.keys(demoGroups())) {
    const doc = await request(`${root}/groups/${id}`);
    if (!doc) continue;
    const members = doc.fields?.memberIds?.arrayValue?.values || [];
    if (!members.some(v => v.stringValue === uid)) continue;
    if (ownedGroups.has(id) || doc.fields?.ownerId?.stringValue === uid) { skipped.push({id, reason: 'Preserve access to real owned content'}); continue; }
    const fields = {};
    for (const key of ['memberIds', 'members', 'goingIds', 'maybeIds']) {
      if (!doc.fields[key]) continue;
      if (!doc.fields[key].arrayValue) throw Error('Unexpected group schema; refusing repair');
      const values = doc.fields[key].arrayValue.values || [];
      fields[key] = {arrayValue: {values: values.filter(v => key === 'members' ? v.mapValue?.fields?.id?.stringValue !== uid : v.stringValue !== uid)}};
    }
    writes.push({update: {name: doc.name, fields}, updateMask: {fieldPaths: Object.keys(fields)}, currentDocument: {updateTime: doc.updateTime}});
    groups.push({id, membersBefore: members.length, membersAfter: members.length - 1});
  }
  const apply = process.argv.includes('--apply');
  if (apply && writes.length) await request(`${root}:commit`, 'POST', {writes});
  const current = await request(`${root}:runQuery`, 'POST', {structuredQuery: {from: [{collectionId: 'groups'}],
    where: {fieldFilter: {field: {fieldPath: 'memberIds'}, op: 'ARRAY_CONTAINS', value: {stringValue: uid}}}}});
  const remaining = current.filter(r => r.document);
  const peers = new Set(remaining.flatMap(r => r.document.fields.memberIds.arrayValue.values || []).map(v => v.stringValue).filter(id => id !== uid));
  console.log(JSON.stringify({project, uid, mode: apply ? 'applied' : 'preview', groups, skipped,
    currentGroups: remaining.length, currentPeers: peers.size,
    preserved: ['account', 'profile', 'activities', 'non-demo groups', 'other members']}, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
