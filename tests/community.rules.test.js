const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, getDoc, setDoc, updateDoc} = require('firebase/firestore');
let env;
test.before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-parchapp-phase-c-rules', firestore: {host: '127.0.0.1', port: 8080, rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')}});
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'team'), {ownerId: 'owner', memberIds: ['owner','peer'], members: [], goingIds: [], maybeIds: [], pendingInvites: []});
    await setDoc(doc(db, 'profiles', 'peer'), {preferences: {scheduleVisibility: 'private'}});
    await setDoc(doc(db, 'availability', 'peer', 'days', '2026-10-20'), {busy: [{start: 500, end: 600}]});
    await setDoc(doc(db, 'groupInvitations', 'peer', 'items', 'team'), {state: 'pending'});
  });
});
test.after(async () => env?.cleanup());
test('clients cannot forge group membership, ownership, invitation acceptance or receipts', async () => {
  const db = env.authenticatedContext('peer').firestore();
  await assertFails(setDoc(doc(db, 'groups', 'forged'), {ownerId: 'peer', memberIds: ['peer']}));
  await assertFails(updateDoc(doc(db, 'groups', 'team'), {ownerId: 'peer'}));
  await assertFails(updateDoc(doc(db, 'groups', 'team'), {memberIds: ['owner','peer','stranger']}));
  await assertFails(updateDoc(doc(db, 'groupInvitations', 'peer', 'items', 'team'), {state: 'accepted'}));
  await assertFails(setDoc(doc(db, 'groupCommands', 'peer', 'requests', 'forged'), {receipt: {groupId: 'team'}}));
});
test('profiles, dated schedules and invitations are read only through authorized callables', async () => {
  const db = env.authenticatedContext('owner').firestore();
  await assertFails(getDoc(doc(db, 'profiles', 'peer')));
  await assertFails(getDoc(doc(db, 'availability', 'peer', 'days', '2026-10-20')));
  await assertFails(getDoc(doc(db, 'groupInvitations', 'peer', 'items', 'team')));
  await assertFails(setDoc(doc(db, 'profiles', 'owner'), {preferences: {scheduleVisibility: 'private'}}));
  await assertSucceeds(getDoc(doc(db, 'groups', 'team')));
  await assertFails(getDoc(doc(env.authenticatedContext('stranger').firestore(), 'groups', 'team')));
});
