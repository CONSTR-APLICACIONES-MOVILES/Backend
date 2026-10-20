// Local-only fixtures and verification. Never uses ADC or a cloud project.
const assert = require('node:assert/strict');
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const {initializeApp} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {memberForAccount} = require('../src/demoData');
initializeApp({projectId: 'demo-parchapp'});
const auth = getAuth();
const db = getFirestore();
const people = [
  {uid: 'local-test-alex-valenzuela', email: 'a.va@test.com', password: '12345678', displayName: 'Alex Valenzuela'},
  {uid: 'local-test-organizer', email: 'organizer@parchapp.test', password: 'ParchApp123!', displayName: 'Mateo Torres'},
  {uid: 'local-test-participant', email: 'participant@parchapp.test', password: 'ParchApp123!', displayName: 'Camila Rojas'},
];
const groupIds = ['test-flutter-study', 'test-flutter-social'];

async function seed() {
  const users = [];
  for (const person of people) {
    let existing;
    try { existing = await auth.getUserByEmail(person.email); }
    catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
    // Keep existing UIDs: local sessions and related records remain linked.
    const user = existing
      ? await auth.updateUser(existing.uid, {password: person.password,
        displayName: person === people[0] ? person.displayName : existing.displayName || person.displayName})
      : await auth.createUser(person);
    users.push(user);
    const profile = db.doc(`profiles/${user.uid}`);
    if (!(await profile.get()).exists) {
      await profile.create({name: user.displayName, status: 'active'});
    }
  }
  const members = users.map(u => memberForAccount(u.uid, u.email, u.displayName));
  for (const [index, id] of groupIds.entries()) {
    const ref = db.doc(`groups/${id}`);
    await db.runTransaction(async tx => {
      const before = (await tx.get(ref)).data();
      const priorMembers = before?.members || [];
      const additions = members.filter(m => !priorMembers.some(p => p.id === m.id));
      tx.set(ref, before
        ? {members: [...priorMembers, ...additions], memberIds: [...new Set([...(before.memberIds || []), ...members.map(m => m.id)])]}
        : {name: index === 0 ? 'Flutter Study Group' : 'Flutter Social Group', icon: index === 0 ? '📚' : '⚽',
          planTitle: '', members, memberIds: members.map(m => m.id), goingIds: [], maybeIds: [], pendingInvites: []},
      {merge: true});
    });
  }
  // Only create missing examples. Never reset responses, edits or invitations.
  const examples = [
    {id: 'test-study-invitation', groupId: groupIds[0], createdBy: users[1].uid, title: 'Study with Mateo', category: 'study', location: 'Library'},
    {id: 'test-social-invitation', groupId: groupIds[1], createdBy: users[2].uid, title: 'Plan with Camila', category: 'social', location: 'Campus'},
    {id: 'test-alex-activity', groupId: groupIds[0], createdBy: users[0].uid, title: 'Alex study session', category: 'study', location: 'Library'},
  ];
  for (const {id, ...data} of examples) {
    const ref = db.doc(`activities/${id}`);
    if (!(await ref.get()).exists) {
      await ref.create({...data, description: 'Local integration test', date: '', time: '',
        status: 'PROPOSED', createdAt: FieldValue.serverTimestamp()});
    }
  }
}

async function verify() {
  const login = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: people[0].email, password: people[0].password, returnSecureToken: true}),
  });
  const session = await login.json();
  assert.ok(login.ok, 'Alex email/password login failed');
  assert.equal((await auth.getUser(session.localId)).displayName, 'Alex Valenzuela');
  async function call(name, data = {}) {
    const response = await fetch(`http://127.0.0.1:5001/demo-parchapp/us-central1/${name}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${session.idToken}`},
      body: JSON.stringify({data}),
    });
    const payload = await response.json();
    assert.ok(response.ok, `${name}: ${JSON.stringify(payload.error)}`);
    return payload.result ?? payload.data;
  }
  const profile = await call('getProfile');
  assert.equal(profile.id, session.localId);
  assert.equal(profile.name, 'Alex Valenzuela');
  assert.ok(profile.activeGroups >= 2);
  const friends = (await call('getScheduleFriends')).friends;
  const peers = await Promise.all(people.slice(1).map(p => auth.getUserByEmail(p.email)));
  for (const peer of peers) assert.ok(friends.some(f => f.id === peer.uid), 'Existing test peer missing');
  const activities = (await call('getActivities')).activities;
  const alerts = (await call('getAlerts')).alerts;
  assert.ok(activities.some(a => a.id === 'test-alex-activity'));
  for (const id of ['test-study-invitation', 'test-social-invitation']) {
    assert.ok(alerts.some(a => a.id === id), 'Seeded invitation missing');
  }
  // Exercise an acknowledged write and subsequent read; no RSVP is consumed.
  const status = profile.status || 'active';
  await call('updateProfile', {fields: {status}, clientUserId: session.localId});
  assert.equal((await call('getProfile')).status, status);
  console.log(`PASS: Alex login, ${profile.activeGroups} groups, ${friends.length} peers, ${activities.length} activities, invitation inbox and profile write/read.`);
  console.log(`Associated peers: ${friends.map(friend => friend.name).join(', ')}`);
  console.log('Local test account: Alex Valenzuela | a.va@test.com | 12345678');
}

(async () => {
  if (!process.argv.includes('--verify-only')) await seed();
  await verify();
  await db.terminate();
})().catch(async error => { console.error(error.message); await db.terminate(); process.exitCode = 1; });
