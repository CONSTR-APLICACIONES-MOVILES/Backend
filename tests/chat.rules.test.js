const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, serverTimestamp} = require('firebase/firestore');
let env;
test.before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-parchapp-chat-rules', firestore: {host: '127.0.0.1', port: 8080, rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')}});
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'groups', 'house'), {ownerId: 'ana', memberIds: ['ana', 'luis'], members: [], goingIds: [], maybeIds: [], pendingInvites: []});
    await setDoc(doc(db, 'groups', 'house', 'messages', 'old'), {senderId: 'luis', text: 'hi'});
    await setDoc(doc(db, 'directChats', 'ana_luis', 'messages', 'old'), {senderId: 'luis', text: 'hi'});
  });
});
test.after(async () => env?.cleanup());

const message = (senderId, extra = {}) => ({senderId, senderName: 'Ana', senderInitials: 'A', text: 'Dinner at 8?',
  kind: 'text', createdAt: serverTimestamp(), ...extra});

test('house chat: members read and write their own messages, others cannot', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  const stranger = env.authenticatedContext('stranger').firestore();
  await assertSucceeds(getDoc(doc(ana, 'groups', 'house', 'messages', 'old')));
  await assertSucceeds(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana')));
  await assertSucceeds(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana', {kind: 'slot', text: '5:30 PM – 7:00 PM · Today · 2/2 free'})));
  await assertFails(getDoc(doc(stranger, 'groups', 'house', 'messages', 'old')));
  await assertFails(addDoc(collection(stranger, 'groups', 'house', 'messages'), message('stranger')));
});

test('a message can not be forged, faked in time, edited or deleted', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  await assertFails(addDoc(collection(ana, 'groups', 'house', 'messages'), message('luis')));
  await assertFails(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana', {createdAt: new Date(0)})));
  await assertFails(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana', {text: ''})));
  await assertFails(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana', {kind: 'voice'})));
  await assertFails(addDoc(collection(ana, 'groups', 'house', 'messages'), message('ana', {admin: true})));
  await assertFails(updateDoc(doc(ana, 'groups', 'house', 'messages', 'old'), {text: 'changed'}));
  await assertFails(deleteDoc(doc(ana, 'groups', 'house', 'messages', 'old')));
});

test('direct chat: only the two people of the id read and write', async () => {
  const ana = env.authenticatedContext('ana').firestore();
  const stranger = env.authenticatedContext('stranger').firestore();
  await assertSucceeds(getDoc(doc(ana, 'directChats', 'ana_luis', 'messages', 'old')));
  await assertSucceeds(addDoc(collection(ana, 'directChats', 'ana_luis', 'messages'), message('ana')));
  await assertFails(getDoc(doc(stranger, 'directChats', 'ana_luis', 'messages', 'old')));
  await assertFails(addDoc(collection(stranger, 'directChats', 'ana_luis', 'messages'), message('stranger')));
  await assertFails(addDoc(collection(ana, 'directChats', 'ana_luis_x', 'messages'), message('ana')));
});
