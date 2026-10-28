const {createHash, randomUUID} = require('node:crypto');
const {CAMPUS_AREAS} = require("./campusAreas");
const {requireThat, documentId, integer} = require('./errors');
const {localDate, dayStart, MINUTE, hasSchedule, TIME_ZONE} = require('./availability');

const {canShare} = require('./communityService');

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const versionOf = doc => `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}`;
function instant(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'invalid-argument', 'Use a UTC timestamp at minute precision.');
  const parsed = new Date(value);
  requireThat(parsed.toISOString().slice(0, 10) === value.slice(0, 10), 'invalid-argument', 'Invalid calendar date.');
  return parsed;
}
function interval(input, now) {
  requireThat(input.timeZone === TIME_ZONE, 'invalid-argument', 'Use America/Bogota.');
  const start = instant(input.startTime), end = instant(input.endTime);
  const minutes = (end - start) / MINUTE;
  integer(minutes, 15, 720, 'durationMinutes');
  requireThat(start > now && localDate(start) === localDate(new Date(end.getTime() - 1)),
    'failed-precondition', 'Choose a future interval within one day in Bogota.');
  return {start, end, minutes, date: localDate(start)};
}
function metadata(input) {
  const fields = input.fields;
  requireThat(fields && typeof fields === 'object' && !Array.isArray(fields) &&
    Object.keys(fields).every(k => ['title', 'description', 'category', 'location', 'status', 'date', 'time'].includes(k)),
  'invalid-argument', 'Unsupported activity fields.');
  const text = (key, max, fallback = '') => {
    const value = fields[key] ?? fallback;
    requireThat(typeof value === 'string' && value.trim().length <= max,
      'invalid-argument', `${key} is invalid or too long.`);
    return value.trim();
  };
  const result = {title: text('title', 120), description: text('description', 5000),
    location: text('location', 500), category: text('category', 20, 'study'),
    status: text('status', 20, 'PROPOSED'), date: text('date', 50), time: text('time', 100)};
  requireThat(result.title && ['study', 'sports', 'social', 'other'].includes(result.category) &&
    ['PROPOSED', 'CONFIRMED'].includes(result.status), 'invalid-argument', 'Choose valid activity details.');
  return result;
}

function timeBucket(minutes) {
  const hour = Math.floor(minutes / 60);
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}
function participants(input, group, uid) {
  const ids = input ?? group.memberIds;
  requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
    new Set(ids).size === ids.length && ids.includes(uid) && ids.every(id => group.memberIds.includes(id)),
  'permission-denied', 'Participants must belong to the selected group, including the organizer.');
  ids.forEach(id => documentId(id, 'participantId'));
  return [...ids].sort();
}
async function availabilitySnapshot(db, tx, group, ids, slot, now, viewer) {
  for (const id of ids) requireThat(await canShare(db, id, viewer, "scheduleVisibility", tx), "permission-denied", "A participant does not share availability with you.");
  const docs = await tx.getAll(...ids.map(id => db.doc(`availability/${id}/days/${slot.date}`)));
  const result = {};
  const start = (slot.start.getTime() - dayStart(slot.date)) / MINUTE;
  const end = (slot.end.getTime() - dayStart(slot.date)) / MINUTE;
  ids.forEach((id, index) => {
    const member = group.members?.find(member => member.id === id);
    const saved = docs[index].data();
    const busy = saved ? saved.busy : slot.date === localDate(now) && !member?.calendarSync ? member?.busy : undefined;
    result[id] = busy === undefined ? 'UNKNOWN' : busy.some(block => start < block.end && end > block.start) ? 'BUSY' : 'AVAILABLE';
    requireThat(hasSchedule({busy}) && !busy.some(block => start < block.end && end > block.start),
      'failed-precondition', 'Availability is unknown or the selected slot is no longer free. Compare again.');
  });
  return result;
}

async function available(db, tx, group, ids, slot, now, viewer) {
  return availabilitySnapshot(db, tx, group, ids, slot, now, viewer);
}

function lifecycleEvent(tx, db, activityId, type, now, metadata = {}) {
  const eventId = `${type.toLowerCase()}-${now.getTime()}`;
  tx.set(db.doc(`activities/${activityId}/lifecycle/${eventId}`), {
    type, createdAt: now, ...metadata,
  }, {merge: true});
}

class ActivityLifecycle {
  constructor(db, {clock = () => new Date()} = {}) { this.db = db; this.clock = clock; }

  async validatePlanningSlot(uid, input) {
    const slot = interval(input, this.clock());
    requireThat(Array.isArray(input.participantIds) && input.participantIds.length <= 11,
      'invalid-argument', 'Choose up to ten peers.');
    const ids = [...new Set([uid, ...input.participantIds])].sort();
    ids.forEach(id => documentId(id, 'participantId'));
    const comparisonId = randomUUID();
    return this.db.runTransaction(async tx => {
      const query = this.db.collection('groups').where('memberIds', 'array-contains', uid);
      const groups = (await tx.get(query)).docs;
      const peers = new Map(groups.flatMap(g => (g.data().members || []).map(m => [m.id, m])));
      requireThat(ids.every(id => id === uid || peers.has(id)), 'permission-denied', 'Compare shared group members only.');
      if (input.groupId) {
        documentId(input.groupId, 'groupId');
        const group = groups.find(g => g.id === input.groupId)?.data();
        requireThat(group && ids.every(id => group.memberIds.includes(id)),
          'permission-denied', 'The selected group does not contain these participants.');
      }
      const now = this.clock();
      await available(this.db, tx, {members: [...peers.values()]}, ids, slot, now, uid);
      const record = {uid, participantIds: ids, startTime: slot.start.toISOString(),
        endTime: slot.end.toISOString(), timeZone: TIME_ZONE, durationMinutes: slot.minutes,
        groupId: input.groupId || null, sourceSlotId: String(input.sourceSlotId || '').slice(0, 200),
        generatedAt: now, expiresAt: new Date(now.getTime() + 5 * MINUTE)};
      tx.create(this.db.doc(`planningComparisons/${comparisonId}`), record);
      return {...record, comparisonId, generatedAt: now.toISOString(), expiresAt: record.expiresAt.toISOString()};
    });
  }

  async publishActivity(uid, input) {
    documentId(input.requestId, 'requestId'); documentId(input.groupId, 'groupId');
    requireThat(input.locationAreaId === undefined ||
      [...CAMPUS_AREAS.map((area) => area.id), 'unknown'].includes(input.locationAreaId),
    'invalid-argument', 'Use a supported location area.');
    if (input.minimumNoticeMinutes !== undefined) integer(input.minimumNoticeMinutes, 0, 1440, 'minimumNoticeMinutes');
    const fields = metadata(input);
    const fingerprint = hash(input);
    const commandRef = this.db.doc(`activityCommands/${uid}/requests/${input.requestId}`);
    const activityId = `mobile-${hash([uid, input.requestId]).slice(0, 40)}`;
    return this.db.runTransaction(async tx => {
      const command = (await tx.get(commandRef)).data();
      if (command) {
        requireThat(command.fingerprint === fingerprint, 'already-exists',
          'This publication key has different details. Resolve the previous attempt first.');
        return command.receipt;
      }
      const group = (await tx.get(this.db.doc(`groups/${input.groupId}`))).data();
      requireThat(group?.memberIds?.includes(uid), 'permission-denied', 'Group membership is required.');
      const ids = participants(input.participantIds, group, uid);
      const now = this.clock();
      const scheduled = input.startTime != null || input.endTime != null;
      let slot;
      if (scheduled) slot = interval(input, now);
      let availability = {};
      if (input.comparisonId != null) {
        documentId(input.comparisonId, 'comparisonId');
        const evidence = (await tx.get(this.db.doc(`planningComparisons/${input.comparisonId}`))).data();
        requireThat(slot && evidence?.uid === uid && evidence.expiresAt.toDate() > now &&
          evidence.startTime === slot.start.toISOString() && evidence.endTime === slot.end.toISOString() &&
          JSON.stringify(evidence.participantIds) === JSON.stringify(ids) &&
          (!evidence.groupId || evidence.groupId === input.groupId),
        'failed-precondition', 'Comparison expired or changed. Compare again before publishing.');
         availability = await availabilitySnapshot(this.db, tx, group, ids, slot, now, uid);
      }
      const receipt = {activityId, created: true, scheduled,
        confirmed: fields.status === 'CONFIRMED', invitationCount: ids.filter(id => id !== uid).length,
        startTime: slot?.start.toISOString() ?? null, endTime: slot?.end.toISOString() ?? null,
        timeZone: TIME_ZONE};
      const displayStart = slot ? (slot.start.getTime() - dayStart(slot.date)) / MINUTE : null;
      const planningContext = {
        groupSizeAtCreation: ids.length,
        minimumNoticeMinutes: input.minimumNoticeMinutes ?? null,
        comparisonUsed: input.comparisonId != null,
        comparisonId: input.comparisonId || null,
        locationAreaId: input.locationAreaId || 'unknown',
        timeBucket: displayStart == null ? 'unknown' : timeBucket(displayStart),
      };
      tx.create(this.db.doc(`activities/${activityId}`), {...fields, groupId: input.groupId,
         createdBy: uid, createdAt: now, participantIds: ids, cancelled: false,
         planningContext,
         ...(slot ? {startTime: slot.start, endTime: slot.end, durationMinutes: slot.minutes,
           timeZone: TIME_ZONE, date: slot.date,
           time: `${String(Math.floor(displayStart / 60)).padStart(2, '0')}:${String(displayStart % 60).padStart(2, '0')}`} : {}),
         ...(fields.status === 'CONFIRMED' ? {confirmedAt: now} : {}),
         ...(input.comparisonId ? {planningComparisonId: input.comparisonId} : {})});
      lifecycleEvent(tx, this.db, activityId, 'CREATED', now, {groupId: input.groupId, actorId: uid});
      if (fields.status === 'CONFIRMED') lifecycleEvent(tx, this.db, activityId, 'CONFIRMED', now, {groupId: input.groupId, actorId: uid});
      for (const participantId of ids.filter(id => id !== uid)) {
        tx.set(this.db.doc(`inboxes/${participantId}/items/${activityId}`), {
          activityId, groupId: input.groupId, invitedAt: now, response: null,
          availabilityAtInvitation: slot ? (availability[participantId] || 'UNKNOWN') : 'UNKNOWN',
          reminderCount: 0, lastReminderAt: null, lastReminderStrategy: null,
          isRead: false,
        }, {merge: true});
        if (slot) {
          tx.set(this.db.doc(`inboxes/${participantId}/items/${activityId}/reminders/initial`), {
            activityId, purpose: 'rsvp', strategy: 'single_after_60_min', sequence: 1,
            scheduledAt: new Date(now.getTime() + 60 * MINUTE), sentAt: null,
            deliveredAt: null, openedAt: null, respondedAt: null, status: 'SCHEDULED',
          }, {merge: true});
        }
      }
      tx.create(commandRef, {fingerprint, receipt, createdAt: now});
      return receipt;
    });
  }

  async mutate(uid, input, cancel) {
    documentId(input.activityId, 'activityId');
    requireThat(typeof input.expectedVersion === 'string', 'invalid-argument', 'Supply the activity version.');
    const fields = cancel ? null : metadata(input);
    const fingerprint = hash([uid, input]);
    return this.db.runTransaction(async tx => {
      const ref = this.db.doc(`activities/${input.activityId}`);
      const doc = await tx.get(ref), activity = doc.data();
      requireThat(activity, 'not-found', 'Activity not found.');
      const group = (await tx.get(this.db.doc(`groups/${activity.groupId}`))).data();
      requireThat(activity.createdBy === uid && group?.memberIds.includes(uid),
        'permission-denied', 'Only the current organizer may change the activity.');
      const stillMatches = fields && Object.entries(fields).every(([key, value]) => value === (activity[key] ?? ''));
      if (activity.lastMutation === fingerprint && (cancel ? activity.cancelled : stillMatches && !activity.cancelled) || cancel && activity.cancelled) {
        return {activityId: input.activityId, cancelled: !!activity.cancelled, saved: true};
      }
      requireThat(versionOf(doc) === input.expectedVersion, 'aborted', 'Activity changed. Reload before editing.');
      requireThat(!activity.cancelled, 'failed-precondition', 'This activity is cancelled.');
      if (!cancel && activity.startTime) {
        requireThat(fields.date === (activity.date || '') && fields.time === (activity.time || ''),
          'failed-precondition', 'Use recommendations to change a scheduled interval.');
      }
      const now = this.clock();
      const becameConfirmed = !cancel && fields.status === 'CONFIRMED' && activity.status !== 'CONFIRMED';
      tx.update(ref, cancel ? {cancelled: true, cancelledAt: now, lastMutation: fingerprint}
        : {...fields, ...(becameConfirmed ? {confirmedAt: now} : {}), lastMutation: fingerprint, updatedAt: now});
      lifecycleEvent(tx, this.db, input.activityId, cancel ? 'CANCELLED' : becameConfirmed ? 'CONFIRMED' : 'UPDATED', now,
        {groupId: activity.groupId, actorId: uid});
      return {activityId: input.activityId, cancelled: cancel, saved: true};
    });
  }
}
module.exports = {ActivityLifecycle, versionOf};
