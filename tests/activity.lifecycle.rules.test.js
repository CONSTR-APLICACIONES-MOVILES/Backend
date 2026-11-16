const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, getDoc, setDoc, updateDoc, serverTimestamp, arrayUnion} = require('firebase/firestore');
let env;
test.before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-parchapp-phase-b-rules',
    firestore: {host: '127.0.0.1', port: 8080,
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')}});
});
test.after(async () => env?.cleanup());
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'team'), {memberIds: ['organizer', 'member'],
      goingIds: [], maybeIds: [], pendingInvites: []});
    await setDoc(doc(db, 'activities', 'scheduled'), {groupId: 'team', title: 'Scheduled',
      status: 'PROPOSED', createdBy: 'organizer', date: '2026-10-20', time: '10:00',
      startTime: new Date('2026-10-20T15:00:00Z'), endTime: new Date('2026-10-20T16:00:00Z'),
      cancelled: false, participantIds: ['organizer', 'member']});
    await setDoc(doc(db, 'activities', 'cancelled'), {groupId: 'team', title: 'Cancelled',
      status: 'CONFIRMED', createdBy: 'organizer', cancelled: true});
  });
});
test('Java legacy creation and own group RSVP remain allowed', async () => {
  const db = env.authenticatedContext('organizer').firestore();
  await assertSucceeds(setDoc(doc(db, 'activities', 'legacy'), {groupId: 'team',
    createdBy: 'organizer', createdAt: serverTimestamp(), status: 'PROPOSED', title: 'Legacy'}));
  await assertSucceeds(updateDoc(doc(db, 'groups', 'team'), {goingIds: arrayUnion('organizer')}));
});
test('canonical schedules, cancellation and command evidence are server owned', async () => {
  const db = env.authenticatedContext('organizer').firestore();
  await assertFails(updateDoc(doc(db, 'activities', 'scheduled'), {startTime: new Date()}));
  await assertFails(updateDoc(doc(db, 'activities', 'scheduled'), {cancelled: true}));
  await assertFails(setDoc(doc(db, 'planningComparisons', 'forged'), {uid: 'organizer'}));
  await assertFails(setDoc(doc(db, 'activityCommands', 'organizer', 'requests', 'forged'), {created: true}));
});
test('cancelled activities reject metadata edits while active legacy edits still work', async () => {
  const db = env.authenticatedContext('organizer').firestore();
  await assertFails(updateDoc(doc(db, 'activities', 'cancelled'), {title: 'Revived'}));
  await assertSucceeds(updateDoc(doc(db, 'activities', 'scheduled'), {title: 'Edited', status: 'CONFIRMED'}));
  await assertFails(updateDoc(doc(db, 'activities', 'scheduled'), {date: '2030-10-20'}));
});
test('unauthenticated and outsider activity reads remain forbidden', async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'activities', 'scheduled')));
  await assertFails(getDoc(doc(env.authenticatedContext('outsider').firestore(), 'activities', 'scheduled')));
  await assertSucceeds(getDoc(doc(env.authenticatedContext('member').firestore(), 'activities', 'scheduled')));
});
