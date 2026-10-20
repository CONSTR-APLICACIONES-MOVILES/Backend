const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const req = require('node:module').createRequire(require.resolve('../functions/package.json'));
const {initializeApp, deleteApp} = req('firebase-admin/app');
const {getFirestore} = req('firebase-admin/firestore');
const {MobileService} = require('../functions/src/mobileService');
const {createMobileCallables} = require('../functions/src/mobileCallables');
const {ActivityRepository} = require('../functions/src/activityRepository');
const {ActivityService} = require('../functions/src/activityService');
const project = 'demo-parchapp-phase-c';
let app, db, api, now;
const call = (name, data = {}, uid = 'owner') => api[name].run({data, auth: uid ? {uid} : undefined});
const creation = extra => ({requestId: 'create-1', name: 'Study team', category: 'study', inviteeIds: ['peer'], ...extra});
const preferences = extra => ({preferences: {statusVisibility: 'groups', scheduleVisibility: 'groups', closeFriendIds: [], invitationBadges: true, ...extra}});
test.before(() => {
  app = initializeApp({projectId: project}, 'community-tests'); db = getFirestore(app);
  api = createMobileCallables(new MobileService(db, {clock: () => now, userLookup: async uid => ({displayName: uid, email: `${uid}@test.example`})}));
});
test.beforeEach(async () => {
  now = new Date('2026-10-20T13:00:00Z');
  assert.ok((await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`, {method: 'DELETE'})).ok);
  await db.doc('groups/shared').set({name: 'Shared', members: ['owner','peer','other'].map(id => ({id, name: id, busy: [{start: 800, end: 850}]})), memberIds: ['owner','peer','other'], goingIds: [], maybeIds: [], pendingInvites: []});
  for (const id of ['owner','peer','other']) await db.doc(`availability/${id}/days/2026-10-20`).set({busy: [], updatedAt: now});
});
test.after(async () => { await db?.terminate(); if (app) await deleteApp(app); });

test('creation is idempotent, owned, and requires consent before membership', async () => {
  const [created, retry] = await Promise.all([call('createGroup', creation()), call('createGroup', creation())]);
  assert.equal(created.groupId, retry.groupId);
  let detail = await call('getGroupDetails', {groupId: created.groupId});
  assert.equal(detail.ownerId, 'owner'); assert.deepEqual(detail.members.map(m => m.id), ['owner']);
  await assert.rejects(call('getGroupDetails', {groupId: created.groupId}, 'peer'), {code: 'permission-denied'});
  assert.equal((await call('getGroupInvitations', {}, 'peer')).invitations[0].state, 'pending');
  await call('respondGroupInvitation', {groupId: created.groupId, response: 'accepted'}, 'peer');
  await call('respondGroupInvitation', {groupId: created.groupId, response: 'accepted'}, 'peer');
  detail = await call('getGroupDetails', {groupId: created.groupId}, 'peer');
  assert.deepEqual(detail.members.map(m => m.id), ['owner','peer']);
  assert.equal(detail.invitations.length, 0);
  await assert.rejects(call('createGroup', creation({name: 'Changed'})), {code: 'already-exists'});
});
test('creation validates auth, names, duplicates and shared membership', async () => {
  await assert.rejects(call('createGroup', creation(), null), {code: 'unauthenticated'});
  for (const extra of [{name: ' '}, {category: 'bad'}, {inviteeIds: ['peer','peer']}, {inviteeIds: ['owner']}]) await assert.rejects(call('createGroup', creation(extra)), {code: 'invalid-argument'});
  await assert.rejects(call('createGroup', creation({inviteeIds: ['stranger']})), {code: 'permission-denied'});
  await assert.rejects(call('createGroup', {...creation(), ownerId: 'peer'}), {code: 'invalid-argument'});
});
test('only owner revokes; invitation cannot be accepted after revocation', async () => {
  const {groupId} = await call('createGroup', creation());
  await assert.rejects(call('revokeGroupInvitation', {groupId, inviteeId: 'peer'}, 'other'), {code: 'permission-denied'});
  await call('revokeGroupInvitation', {groupId, inviteeId: 'peer'});
  await call('revokeGroupInvitation', {groupId, inviteeId: 'peer'});
  assert.equal((await call('getGroupInvitations', {}, 'peer')).invitations[0].state, 'revoked');
  await assert.rejects(call('respondGroupInvitation', {groupId, response: 'accepted'}, 'peer'), {code: 'failed-precondition'});
});
test('expired and declined invitations do not create membership; identity is isolated', async () => {
  const {groupId} = await call('createGroup', creation());
  await assert.rejects(call('respondGroupInvitation', {groupId, response: 'accepted'}, 'other'), {code: 'permission-denied'});
  now = new Date('2026-10-28T13:00:00Z');
  assert.equal((await call('getGroupInvitations', {}, 'peer')).invitations[0].state, 'expired');
  await assert.rejects(call('respondGroupInvitation', {groupId, response: 'accepted'}, 'peer'), {code: 'failed-precondition'});
  const second = await call('createGroup', creation({requestId: 'second'}));
  await call('respondGroupInvitation', {groupId: second.groupId, response: 'declined'}, 'peer');
  await assert.rejects(call('getGroupDetails', {groupId: second.groupId}, 'peer'), {code: 'permission-denied'});
});
test('status expiry and visibility apply to group details without sharing private profile fields', async () => {
  await call('updatePresence', {status: 'focused', visibility: 'private', expiresAt: '2026-10-20T14:00:00Z'}, 'peer');
  assert.equal((await call('getGroupDetails', {groupId: 'shared'})).members.find(m => m.id === 'peer').status, null);
  assert.equal((await call('getProfile', {}, 'peer')).status, 'focused');
  await call('updatePreferences', preferences({statusVisibility: 'closeFriends', closeFriendIds: ['owner']}), 'peer');
  assert.equal((await call('getGroupDetails', {groupId: 'shared'})).members.find(m => m.id === 'peer').status, 'focused');
  assert.equal((await call('getGroupDetails', {groupId: 'shared'}, 'other')).members.find(m => m.id === 'peer').status, null);
  now = new Date('2026-10-20T14:00:00Z');
  assert.equal((await call('getProfile', {}, 'peer')).status, 'offline');
  assert.equal((await call('getGroupDetails', {groupId: 'shared'})).members.find(m => m.id === 'peer').status, 'offline');
  await call('updateProfile', {fields: {status: 'active'}}, 'peer');
  assert.equal((await call('getProfile', {}, 'peer')).status, 'active');
  assert.equal((await call('getProfile', {}, 'peer')).statusExpiresAt, null);
});
test('presence rejects invalid/past/overlong expiry and unsupported states or visibility', async () => {
  const valid = {status: 'inClass', visibility: 'groups', expiresAt: '2026-10-20T14:00:00Z'};
  for (const extra of [{status: 'gps'}, {visibility: 'everyone'}, {expiresAt: 'bad'}, {expiresAt: '2026-10-20T12:00:00Z'}, {expiresAt: '2026-10-22T14:00:00Z'}]) await assert.rejects(call('updatePresence', {...valid, ...extra}), {code: 'invalid-argument'});
  await call('updatePresence', valid); assert.equal((await call('getProfile')).status, 'inClass');
});
test('calendar privacy applies to day reads, comparison and publication revalidation', async () => {
  const slot = {groupId: 'shared', participantIds: ['peer'], sourceSlotId: 's', startTime: '2026-10-20T15:00:00Z', endTime: '2026-10-20T16:00:00Z', timeZone: 'America/Bogota'};
  const comparison = await call('validatePlanningSlot', slot);
  await call('updatePreferences', preferences({scheduleVisibility: 'private'}), 'peer');
  await call('importCalendarAvailability', {startDate: '2026-10-20', days: 1, intervals: []}, 'peer');
  const day = await call('getScheduleDay', {date: '2026-10-20', friendIds: ['peer']});
  assert.equal(day.schedules[1].known, false); assert.deepEqual(day.schedules[1].busy, []);
  assert.equal((await db.doc('groups/shared').get()).data().members.find(m => m.id === 'peer').busy, undefined);
  await assert.rejects(call('validatePlanningSlot', slot), {code: 'permission-denied'});
  await assert.rejects(call('publishActivity', {requestId: 'p1', groupId: 'shared', fields: {title: 'Plan'}, ...slot, comparisonId: comparison.comparisonId, participantIds: comparison.participantIds}), {code: 'invalid-argument'});
  // Remove the comparison-only source key from the publication contract.
  const {sourceSlotId, ...interval} = slot;
  await assert.rejects(call('publishActivity', {requestId: 'p1', fields: {title: 'Plan'}, ...interval, comparisonId: comparison.comparisonId, participantIds: comparison.participantIds}), {code: 'permission-denied'});
  await call('updatePreferences', preferences({scheduleVisibility: 'closeFriends', closeFriendIds: ['owner']}), 'peer');
  await call('validatePlanningSlot', slot);
  await assert.rejects(call('validatePlanningSlot', slot, 'other'), {code: 'permission-denied'});
});
test('preferences are persisted by UID; nonpeer close friends rejected', async () => {
  await call('updatePreferences', preferences({invitationBadges: false, closeFriendIds: ['peer']}));
  assert.equal((await call('getProfile')).preferences.invitationBadges, false);
  assert.equal((await call('getProfile', {}, 'peer')).preferences.invitationBadges, true);
  await assert.rejects(call('updatePreferences', preferences({closeFriendIds: ['outsider']})), {code: 'permission-denied'});
});
test('details use activity responses and preserve proposal/cancelled history', async () => {
  await db.doc('activities/a1').set({groupId: 'shared', title: 'Plan', status: 'PROPOSED', cancelled: true, createdBy: 'owner', createdAt: now, participantIds: ['owner','peer']});
  await db.doc('inboxes/peer/items/a1').set({response: 'maybe'});
  const detail = await call('getGroupDetails', {groupId: 'shared'});
  assert.equal(detail.activities[0].cancelled, true);
  assert.deepEqual(detail.activities[0].attendance, {accepted: 1, maybe: 1, declined: 0, pending: 0});
  await assert.rejects(call('getGroupDetails', {groupId: 'shared'}, 'stranger'), {code: 'permission-denied'});
});

test('activity details and recommendations also honor calendar privacy', async () => {
  await db.doc('activities/private').set({groupId: 'shared', title: 'Private plan', status: 'PROPOSED', createdBy: 'owner', category: 'study', createdAt: now, startTime: new Date('2026-10-20T15:00:00Z'), endTime: new Date('2026-10-20T16:00:00Z')});
  await call('updatePreferences', preferences({scheduleVisibility: 'private'}), 'peer');
  const service = new ActivityService(new ActivityRepository(db), {clock: () => now});
  const detail = await service.getActivity('owner', {activityId: 'private'});
  assert.equal(detail.participants.find(p => p.id === 'peer').availability, 'UNKNOWN');
  await assert.rejects(service.getActivityRecommendations('owner', {activityId: 'private', date: '2026-10-20', durationMinutes: 60}));
});

test('profile mutations reject stale account identity and schedule friend lists stay inside group context', async () => {
  await assert.rejects(call('updatePresence', {status: 'focused', visibility: 'private', expiresAt: '2026-10-20T14:00:00Z', clientUserId: 'peer'}), {code: 'permission-denied'});
  await assert.rejects(call('updatePreferences', {...preferences({}), clientUserId: 'peer'}), {code: 'permission-denied'});
  const {groupId} = await call('createGroup', creation());
  assert.deepEqual((await call('getScheduleFriends', {groupId})).friends, []);
  await assert.rejects(call('getScheduleFriends', {groupId}, 'peer'), {code: 'permission-denied'});
  await call('respondGroupInvitation', {groupId, response: 'accepted'}, 'peer');
  assert.deepEqual((await call('getScheduleFriends', {groupId})).friends.map(f => f.id), ['peer']);
});
