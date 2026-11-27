const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, getDoc, setDoc, Timestamp} = require('firebase/firestore');

// the Flutter Schedule and Andes Events read these collections directly, Java goes through callables
let env;
test.before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-parchapp-flutter-rules', firestore: {host: '127.0.0.1', port: 8080, rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')}});
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'andesEvents', 'feria'), {title: 'Feria', published: true});
    await setDoc(doc(db, 'andesEvents', 'draft'), {title: 'Draft', published: false});
    await setDoc(doc(db, 'users', 'ana', 'friends', 'luis'), {friendId: 'luis', status: 'accepted'});
    await setDoc(doc(db, 'availability', 'luis', 'slots', 's1'), {start: Timestamp.now(), end: Timestamp.now(), dayKey: '2026-11-27'});
    await setDoc(doc(db, 'schedules', 'luis', 'slots', 's1'), {title: 'Private class'});
    await setDoc(doc(db, 'andesSchedule', 'ana', 'events', 'feria'), {start: 1, end: 2});
  });
});
test.after(async () => env?.cleanup());

test('andes events: signed in users read published events only, nobody writes', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  await assertSucceeds(getDoc(doc(ana, 'andesEvents', 'feria')));
  await assertFails(getDoc(doc(ana, 'andesEvents', 'draft')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'andesEvents', 'feria')));
  await assertFails(setDoc(doc(ana, 'andesEvents', 'mine'), {title: 'x', published: true}));
});

test('availability is shared with accepted friends, the private schedule is not', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  const stranger = env.authenticatedContext('stranger').firestore();
  await assertSucceeds(getDoc(doc(ana, 'availability', 'luis', 'slots', 's1')));
  await assertFails(getDoc(doc(stranger, 'availability', 'luis', 'slots', 's1')));
  await assertFails(getDoc(doc(ana, 'schedules', 'luis', 'slots', 's1')));
});

test('the Java andes schedule stays backend only', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  await assertFails(getDoc(doc(ana, 'andesSchedule', 'ana', 'events', 'feria')));
});
