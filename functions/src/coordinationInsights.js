const {randomUUID} = require('node:crypto');
const {requireThat, documentId} = require('./errors');
const {localDate, dayStart, MINUTE, hasSchedule} = require('./availability');
const {canShare} = require('./communityService');
const DAY = 1440 * MINUTE;
const asDate = value => value?.toDate ? value.toDate() : value ? new Date(value) : null;
const fraction = (n, d) => d ? n / d : null;

function cohortWindow(now) {
  const end = new Date(dayStart(localDate(now)) - 7 * DAY);
  return {start: new Date(end.getTime() - 30 * DAY), end};
}

function buildCoordinationInsight(records, now = new Date()) {
  const {start, end} = cohortWindow(now);
  const unique = new Map();
  for (const row of records) {
    if (!row.activityId || row.environment === 'test') continue;
    const created = asDate(row.createdAt);
    if (!created || created < start || created >= end) continue;
    requireThat(!unique.has(row.activityId), 'failed-precondition', 'Duplicate activity in analytics input.');
    unique.set(row.activityId, row);
  }
  const compared = {activities:0, confirmed:0}, direct = {activities:0, confirmed:0};
  let unknown = 0;
  for (const row of unique.values()) {
    const target = row.comparisonUsed === true ? compared : row.comparisonUsed === false ? direct : null;
    if (!target) { unknown++; continue; }
    target.activities++;
    const created = asDate(row.createdAt), confirmed = asDate(row.firstConfirmedAt);
    if (confirmed && confirmed >= created && confirmed.getTime() <= created.getTime() + 7 * DAY) target.confirmed++;
  }
  for (const group of [compared, direct]) group.confirmationRate = fraction(group.confirmed, group.activities);
  const known = compared.activities + direct.activities;
  return {schemaVersion:1, environment:'production', source:'firestore-server-records',
    windowStart:start.toISOString(), windowEnd:end.toISOString(), updatedAt:now.toISOString(),
    total:unique.size, known, unknown, coverage:fraction(known, unique.size),
    comparisonUsage:fraction(compared.activities, known), compared, direct,
    differencePp:compared.confirmationRate === null || direct.confirmationRate === null ? null :
      (compared.confirmationRate - direct.confirmationRate) * 100};
}

async function prepareProposalComparison(db, uid, input, now = new Date()) {
  requireThat(typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) &&
    Number.isFinite(dayStart(input.date)) && localDate(new Date(dayStart(input.date))) === input.date,
  'invalid-argument', 'Supply a valid date.');
  requireThat(Array.isArray(input.friendIds) && input.friendIds.length >= 1 && input.friendIds.length <= 10 &&
    new Set(input.friendIds).size === input.friendIds.length && !input.friendIds.includes(uid),
  'invalid-argument', 'Choose one to ten distinct peers.');
  input.friendIds.forEach(id => documentId(id, 'friendId'));
  const ids = [uid, ...input.friendIds].sort(), id = randomUUID();
  return db.runTransaction(async tx => {
    const groups = (await tx.get(db.collection('groups').where('memberIds', 'array-contains', uid))).docs;
    const members = new Map(groups.flatMap(g => (g.data().members || []).filter(m => g.data().memberIds.includes(m.id)).map(m => [m.id,m])));
    requireThat(input.friendIds.every(peer => members.has(peer)), 'permission-denied', 'Compare shared group members only.');
    for (const owner of ids) {
      requireThat(await canShare(db, owner, uid, 'scheduleVisibility', tx), 'permission-denied', 'Availability is private.');
      const saved = (await tx.get(db.doc(`availability/${owner}/days/${input.date}`))).data();
      const legacy = members.get(owner);
      const schedule = saved || (input.date === localDate(now) && !legacy?.calendarSync ? legacy : null);
      requireThat(hasSchedule(schedule || {}), 'failed-precondition', 'Availability is unknown. Load valid schedules before comparing.');
    }
    // Comparing a fully busy day is still valid usage; no shared free slot is required.
    tx.create(db.doc(`coordinationComparisons/${id}`), {
      uid, participantIds:ids, date:input.date, groupId:null, source:'server',
      createdAt:now, expiresAt:new Date(now.getTime() + 30 * MINUTE), consumedBy:null,
    });
    return {comparisonEvidenceId:id, participantIds:ids, date:input.date};
  });
}

async function consumeComparison(db, tx, uid, input, ids, activityId, now, date) {
  requireThat(input.measurementVersion === undefined || input.measurementVersion === 1,
    'invalid-argument', 'Unsupported measurement version.');
  if (input.comparisonEvidenceId != null) {
    documentId(input.comparisonEvidenceId, 'comparisonEvidenceId');
    const ref = db.doc(`coordinationComparisons/${input.comparisonEvidenceId}`);
    const record = (await tx.get(ref)).data();
    requireThat(record?.uid === uid && asDate(record.expiresAt) > now && ids.length > 1 &&
      JSON.stringify(record.participantIds) === JSON.stringify(ids) && (!date || record.date === date) &&
      (!record.groupId || record.groupId === input.groupId) &&
      (!record.consumedBy || record.consumedBy === activityId),
    'failed-precondition', 'Comparison expired, changed or already used. Compare again.');
    // Return the write to perform after all transaction reads (Firestore requires read-before-write).
    return {comparisonUsed:true, evidenceRef:ref};
  }
  return {comparisonUsed:input.measurementVersion === 1 && !input.comparisonId ? false : null};
}

async function recordFirstConfirmation(db, activityId, before, after, eventTime) {
  if (!after || after.analyticsEnvironment === 'test') return;
  const ref = db.doc(`coordinationMeasurements/${activityId}`);
  await db.runTransaction(async tx => {
    const old = (await tx.get(ref)).data();
    const candidate = after.status === 'CONFIRMED' && before?.status !== 'CONFIRMED' ? asDate(eventTime) : null;
    const previous = asDate(old?.firstConfirmedAt);
    const firstConfirmedAt = candidate && (!previous || candidate < previous) ? candidate : previous;
    const createdAt = asDate(old?.createdAt) || asDate(after.createdAt);
    if (!createdAt) return;
    tx.set(ref, {schemaVersion:1, activityId, createdAt, firstConfirmedAt,
      comparisonUsed:old?.comparisonUsed ?? null, environment:old?.environment || 'production'}, {merge:true});
  });
}

async function refreshCoordinationInsight(db, now = new Date()) {
  const {start, end} = cohortWindow(now);
  const snapshot = await db.collection('activities').where('createdAt','>=',start).where('createdAt','<',end).get();
  const rows = [];
  for (let offset = 0; offset < snapshot.docs.length; offset += 200) {
    const docs = snapshot.docs.slice(offset, offset + 200);
    const measurements = await db.getAll(...docs.map(d => db.doc(`coordinationMeasurements/${d.id}`)));
    docs.forEach((d, i) => rows.push({activityId:d.id, createdAt:d.data().createdAt,
      ...measurements[i].data(), environment:d.data().analyticsEnvironment === 'test' ? 'test' : measurements[i].data()?.environment}));
  }
  const insight = buildCoordinationInsight(rows, now);
  await db.doc('insights/bq9_comparison_confirmation').set(insight);
  return insight;
}

module.exports = {asDate, cohortWindow, buildCoordinationInsight, prepareProposalComparison,
  consumeComparison, recordFirstConfirmation, refreshCoordinationInsight};
