const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const {createRequire} = require('node:module');
const req = createRequire(require.resolve('../functions/package.json'));
const {initializeApp, deleteApp} = req('firebase-admin/app');
const {getFirestore} = req('firebase-admin/firestore');
const {MobileService} = require('../functions/src/mobileService');
const {createMobileCallables} = require('../functions/src/mobileCallables');
const {ActivityRepository} = require('../functions/src/activityRepository');
const {ActivityService} = require('../functions/src/activityService');
const {chooseRsvpReminderDelay} = require('../functions/src/reminderTiming');
const {dispatchPendingReminders} = require('../functions/src/reminderService');
// Dedicated database: never clears the user's demo-parchapp fixtures.
const project = 'demo-parchapp-phase-b';
let app, db, mobile, api, activities, now;
const call = (name, data = {}, uid = 'organizer') => api[name].run({data, auth: uid ? {uid} : undefined});
const slot = {participantIds: ['member'], startTime: '2026-10-20T15:00:00.000Z',
  endTime: '2026-10-20T16:00:00.000Z', timeZone: 'America/Bogota', sourceSlotId: 'slot-1', groupId: 'g1'};
const publication = extra => ({requestId: 'publication-1', groupId: 'g1',
  fields: {title: 'Project meeting', category: 'study', status: 'PROPOSED'}, ...extra});
test.before(() => {
  app = initializeApp({projectId: project}, 'phase-b-lifecycle-tests'); db = getFirestore(app);
  mobile = new MobileService(db, {clock: () => now, userLookup: async uid => ({email: `${uid}@test.example`})});
  api = createMobileCallables(mobile);
  activities = new ActivityService(new ActivityRepository(db), {clock: () => now});
});
test.beforeEach(async () => {
  now = new Date('2026-10-20T13:00:00Z');
  const response = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`, {method: 'DELETE'});
  assert.ok(response.ok);
  await db.doc('groups/g1').set({name: 'Team', memberIds: ['organizer', 'member', 'other'],
    members: ['organizer', 'member', 'other'].map(id => ({id, name: id, busy: []})),
    goingIds: ['other'], maybeIds: ['member'], pendingInvites: []});
});
test.after(async () => { await db?.terminate(); if (app) await deleteApp(app); });

test('comparison -> publish -> invitation -> RSVP -> details preserves the selected context', async () => {
  const comparison = await call('validatePlanningSlot', slot);
  const input = publication({startTime: slot.startTime, endTime: slot.endTime,
    timeZone: slot.timeZone, participantIds: comparison.participantIds, comparisonId: comparison.comparisonId});
  const created = await call('publishActivity', input);
  assert.equal(created.scheduled, true); assert.equal(created.confirmed, false); assert.equal(created.invitationCount, 1);
  const detail = await activities.getActivity('member', {activityId: created.activityId});
  assert.equal(detail.groupId, 'g1'); assert.equal(detail.timeZone, slot.timeZone);
  assert.equal(detail.durationMinutes, 60); assert.equal(detail.startTime, slot.startTime);
  assert.deepEqual(detail.participants.map(p => p.id).sort(), ['member', 'organizer']);
  assert.equal((await call('getAlerts', {}, 'member')).alerts[0].id, created.activityId);
  assert.equal((await call('getAlerts', {}, 'other')).alerts.length, 0);
  await call('respondToActivityInvitation', {id: created.activityId, response: 'maybe'}, 'member');
  const after = await activities.getActivity('organizer', {activityId: created.activityId});
  assert.equal(after.participants.find(p => p.id === 'member').activityRsvpStatus, 'maybe');
  const summary = (await call('getActivities')).activities[0];
  assert.deepEqual(summary.attendance, {accepted: 1, maybe: 1, declined: 0, pending: 0, total: 2});
  const group = (await db.doc('groups/g1').get()).data();
  assert.deepEqual(group.goingIds, ['other']); assert.deepEqual(group.maybeIds, ['member']);
});

test('new RSVP reminders use the BQ6 recommended delay and arrive before the activity', async () => {
  await db.doc('insights/bq6_reminder_timing').set({recommended_delay_minutes: 30, recommendation_ready: true});
  const created = await call('publishActivity', publication({
    startTime: slot.startTime, endTime: slot.endTime, timeZone: slot.timeZone,
  }));
  const reminderRef = db.doc(`inboxes/member/items/${created.activityId}/reminders/initial`);
  const reminder = (await reminderRef.get()).data();
  const expectedDelay = chooseRsvpReminderDelay(created.activityId, 'member', 30, 120);

  assert.equal(reminder.delayMinutes, expectedDelay);
  assert.equal(reminder.strategy, `rsvp_after_${expectedDelay}_min`);
  assert.equal(reminder.status, 'SCHEDULED');
  assert.ok(reminder.scheduledAt.toDate() < new Date(slot.startTime));
});

test('dispatch records one delivered RSVP reminder with BQ6 metadata for Alerts', async () => {
  const activityId = 'bq6-reminder-activity';
  await db.doc(`activities/${activityId}`).set({
    groupId: 'g1', title: 'Reminder test', createdBy: 'organizer',
    participantIds: ['member', 'organizer'], cancelled: false,
    createdAt: now, startTime: new Date(now.getTime() + 60 * 60_000),
    date: '2026-10-20', time: '14:00', location: 'Library',
  });
  await db.doc(`inboxes/member/items/${activityId}`).set({
    activityId, groupId: 'g1', invitedAt: now, response: null, reminderCount: 0,
  });
  const reminderRef = db.doc(`inboxes/member/items/${activityId}/reminders/initial`);
  await reminderRef.set({
    activityId, purpose: 'rsvp', strategy: 'rsvp_after_30_min', sequence: 1,
    delayMinutes: 30, scheduledAt: new Date(now.getTime() - 60_000), status: 'SCHEDULED',
  });

  assert.deepEqual(await dispatchPendingReminders(db, {clock: () => now}),
    {checked: 1, dispatched: 1, cancelled: 0});
  const sent = (await reminderRef.get()).data();
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.sentAt.toDate().getTime(), now.getTime());
  const alerts = await mobile.getAlerts('member');
  const reminderAlert = alerts.alerts.find(alert => alert.kind === 'reminder'
    && alert.studySessionId === activityId);
  assert.equal(reminderAlert.reminderPurpose, 'rsvp');
  assert.equal(reminderAlert.reminderId, `reminder-${activityId}-1`);
  assert.equal(reminderAlert.strategy, 'rsvp_after_30_min');
  assert.equal(reminderAlert.delayMinutes, 30);
  assert.equal(reminderAlert.sentAt, now.toISOString());

  assert.deepEqual(await dispatchPendingReminders(db, {clock: () => now}),
    {checked: 0, dispatched: 0, cancelled: 0});
  assert.equal((await db.doc(`inboxes/member/items/${activityId}`).get()).data().reminderCount, 1);
});

test('publication retries and concurrent double submits return one stable ID', async () => {
  const receipts = await Promise.all([call('publishActivity', publication()), call('publishActivity', publication())]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(await call('publishActivity', publication()), receipts[0]);
  assert.equal((await db.collection('activities').get()).size, 1);
  await assert.rejects(call('publishActivity', publication({fields: {title: 'Changed'}})), {code: 'already-exists'});
});

test('unknown, busy, expired and changed comparison contexts fail without creating an activity', async () => {
  await db.doc('availability/member/days/2026-10-20').set({busy: [{start: 600, end: 660}]});
  await assert.rejects(call('validatePlanningSlot', slot), {code: 'failed-precondition'});
  await db.doc('availability/member/days/2026-10-20').set({busy: []});
  const comparison = await call('validatePlanningSlot', slot);
  const input = publication({participantIds: comparison.participantIds, startTime: slot.startTime,
    endTime: slot.endTime, timeZone: slot.timeZone, comparisonId: comparison.comparisonId});
  await db.doc('availability/member/days/2026-10-20').set({busy: [{start: 600, end: 660}]});
  await assert.rejects(call('publishActivity', input), {code: 'failed-precondition'});
  await db.doc('availability/member/days/2026-10-20').set({busy: []});
  now = new Date('2026-10-20T13:06:00Z');
  await assert.rejects(call('publishActivity', input), {code: 'failed-precondition'});
  assert.equal((await db.collection('activities').get()).size, 0);
  await assert.rejects(call('validatePlanningSlot', {...slot, startTime: '2026-10-21T15:00:00.000Z', endTime: '2026-10-21T16:00:00.000Z'}), {code: 'failed-precondition'});
});

test('authorization and required data are checked by server', async () => {
  for (const name of ['publishActivity', 'cancelActivity', 'updateActivityDetails', 'validatePlanningSlot'])
    await assert.rejects(call(name, {}, null), {code: 'unauthenticated'});
  await assert.rejects(call('publishActivity', publication(), 'outsider'), {code: 'permission-denied'});
  await assert.rejects(call('publishActivity', publication({participantIds: ['organizer', 'outsider']})), {code: 'permission-denied'});
  await assert.rejects(call('publishActivity', publication({fields: {title: ''}})), {code: 'invalid-argument'});
  await assert.rejects(call('publishActivity', publication({startTime: slot.startTime, endTime: slot.startTime, timeZone: slot.timeZone})), {code: 'invalid-argument'});
});

test('organizer edits and cancellation are persistent, idempotent and version checked', async () => {
  const receipt = await call('publishActivity', publication());
  const detail = await activities.getActivity('organizer', {activityId: receipt.activityId});
  const edit = {activityId: receipt.activityId, expectedVersion: detail.version, fields: {title: 'Edited meeting', status: 'CONFIRMED'}};
  await assert.rejects(call('updateActivityDetails', edit, 'member'), {code: 'permission-denied'});
  await call('updateActivityDetails', edit); await call('updateActivityDetails', edit);
  // A Java metadata write does not update lastMutation. It must still invalidate an old retry.
  await db.doc(`activities/${receipt.activityId}`).update({title: 'Edited by Java'});
  await assert.rejects(call('updateActivityDetails', edit), {code: 'aborted'});
  await assert.rejects(call('updateActivityDetails', {...edit, fields: {title: 'Stale edit'}}), {code: 'aborted'});
  const updated = await activities.getActivity('organizer', {activityId: receipt.activityId});
  assert.equal(updated.title, 'Edited by Java');
  await assert.rejects(call('cancelActivity', {activityId: receipt.activityId, expectedVersion: detail.version}), {code: 'aborted'});
  const cancel = {activityId: receipt.activityId, expectedVersion: updated.version};
  await assert.rejects(call('cancelActivity', cancel, 'member'), {code: 'permission-denied'});
  await call('cancelActivity', cancel); await call('cancelActivity', cancel);
  const cancelled = await activities.getActivity('member', {activityId: receipt.activityId});
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'CONFIRMED');
  assert.equal((await call('getAlerts', {}, 'member')).alerts.length, 0);
  await assert.rejects(call('respondToActivityInvitation', {id: receipt.activityId, response: 'accepted'}, 'member'), {code: 'failed-precondition'});
});

test('acknowledged schedules remain idempotent after their interval expires and cancelled plans are not completed', async () => {
  const input = publication({startTime: slot.startTime, endTime: slot.endTime, timeZone: slot.timeZone,
    fields: {title: 'Scheduled meeting', category: 'study', status: 'CONFIRMED'}});
  const receipt = await call('publishActivity', input);
  now = new Date('2026-10-20T17:00:00Z');
  assert.deepEqual(await call('publishActivity', input), receipt);
  assert.equal((await call('getProfile')).plansCompleted, 1);
  const detail = await activities.getActivity('organizer', {activityId: receipt.activityId});
  await call('cancelActivity', {activityId: receipt.activityId, expectedVersion: detail.version});
  assert.equal((await call('getProfile')).plansCompleted, 0);
});
