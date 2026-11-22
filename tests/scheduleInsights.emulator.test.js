const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const requireFunctions = createRequire(require.resolve('../functions/package.json'));
const {initializeApp, deleteApp} = requireFunctions('firebase-admin/app');
const {getFirestore} = requireFunctions('firebase-admin/firestore');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, getDoc, setDoc} = require('firebase/firestore');
const {refreshScheduleImportInsight: refresh, INSIGHT_PATH} = require('../functions/src/scheduleInsights');
const {createScheduleInsightCallable} = require('../functions/src/scheduleInsightCallables');
let app, db, env;
const date = '2030-11-13';
const privateSlot = {externalId: 'external', title: 'PRIVATE', description: 'SECRET', location: 'SECRET',
  source: 'google_calendar', start: new Date(`${date}T15:00:00Z`), end: new Date(`${date}T16:00:00Z`),
  dayKey: date, importedAt: new Date()};

test.before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Run with Firestore emulator');
  app = initializeApp({projectId: 'demo-parchapp'}, 'schedule-insight-test');
  db = getFirestore(app);
  env = await initializeTestEnvironment({projectId: 'demo-parchapp',
    firestore: {rules: fs.readFileSync(`${__dirname}/../firestore.rules`, 'utf8')}});
});
test.beforeEach(async () => env.clearFirestore());
test.after(async () => { await env?.cleanup(); await db?.terminate(); if (app) await deleteApp(app); });

test('real snapshot refresh handles mirrors, replacement, empty days, deletion and historical records', async () => {
  const day = db.doc(`availability/owner/days/${date}`);
  await day.set({date, source: 'google', busy: [{start: 600, end: 660}]});
  await db.doc('schedules/owner/slots/event').set(privateSlot);
  await db.doc('availability/owner/slots/event').set({start: privateSlot.start, end: privateSlot.end, dayKey: date});
  await db.doc(`availability/other/days/${date}`).set({date, source: 'manual', busy: [{start: 700, end: 800}]});
  await db.doc('unrelated/owner/slots/event').set(privateSlot);
  await db.doc(`unrelated/owner/days/${date}`).set({date, source: 'google', busy: [{start: 600, end: 660}]});
  await db.doc('insights/bq9_comparison_confirmation').set({untouched: true});
  let result = await refresh(db);
  assert.equal(result.percentage, 50);
  assert.equal(result.totalSlots, 2);
  await day.set({date, source: 'google_calendar', busy: [{start: 100, end: 200}, {start: 300, end: 400}]});
  result = await refresh(db);
  assert.equal(result.googleSlots, 2);
  assert.equal((await refresh(db)).totalSlots, 3);
  await day.set({date, source: 'google', busy: []});
  assert.equal((await refresh(db)).googleSlots, 0);
  // Deleting a preferred representation reveals the still-current fallback.
  await day.delete();
  assert.equal((await refresh(db)).googleSlots, 1);
  await db.doc('schedules/owner/slots/event').delete();
  assert.equal((await refresh(db)).unknownSlots, 1);
  await db.doc('availability/owner/slots/event').delete();
  await db.doc(`availability/other/days/${date}`).delete();
  result = await refresh(db);
  assert.equal(result.totalSlots, 0);
  assert.equal(result.percentage, null);
  const persisted = (await db.doc(INSIGHT_PATH).get()).data();
  assert.ok(persisted.updated_at.toDate());
  assert.deepEqual((await db.doc('insights/bq9_comparison_confirmation').get()).data(), {untouched: true});
  for (const secret of ['owner', 'PRIVATE', 'SECRET', 'external', date]) assert.ok(!JSON.stringify(persisted).includes(secret));
});

test('existing privacy rules keep own details private; dashboard reads only aggregate and cannot forge it', async () => {
  await db.doc('schedules/owner/slots/event').set(privateSlot);
  await refresh(db);
  const owner = env.authenticatedContext('owner').firestore();
  const dashboard = env.authenticatedContext('analyst', {orgAnalytics: true}).firestore();
  const friend = env.authenticatedContext('friend').firestore();
  const anonymous = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(owner, 'schedules/owner/slots/event')));
  await assertFails(getDoc(doc(friend, 'schedules/owner/slots/event')));
  await assertFails(getDoc(doc(dashboard, 'schedules/owner/slots/event')));
  await assertSucceeds(getDoc(doc(dashboard, INSIGHT_PATH)));
  await assertFails(getDoc(doc(anonymous, INSIGHT_PATH)));
  await assertFails(setDoc(doc(dashboard, INSIGHT_PATH), {googleSlots: 999}));
  assert.equal((await db.doc('schedules/owner/slots/event').get()).data().description, 'SECRET');
});

test('organization callable recalculates from Firestore, concurrent refreshes preserve a coherent result', async () => {
  await db.doc(`availability/owner/days/${date}`).set({date, source: 'google', busy: [{start: 60, end: 120}]});
  const callable = createScheduleInsightCallable(db);
  await assert.rejects(callable.run({auth: {uid: 'viewer', token: {}}, data: {}}), {code: 'permission-denied'});
  await callable.run({auth: {uid: 'analyst', token: {orgAnalytics: true}}, data: {}});
  await Promise.all([refresh(db), refresh(db)]);
  const result = (await db.doc(INSIGHT_PATH).get()).data();
  assert.equal(result.googleSlots, 1);
  assert.equal(result.totalSlots, 1);
  assert.equal(result.percentage, 100);
});
