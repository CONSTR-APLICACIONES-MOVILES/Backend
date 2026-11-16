const {createHash} = require('node:crypto');
const {documentId, requireThat, integer} = require('./errors');
const {asDate} = require('./coordinationInsights');
const {localDate, dayStart} = require('./availability');
const DAY = 86400000;
const MIN_SAMPLE = 20;
const pct = (n, d) => d ? Math.round(10000 * n / d) / 100 : null;
const environment = db => db.projectId?.startsWith('demo-') ? 'test' : 'production';
const ms = value => asDate(value)?.getTime();
const inWindow = (date, now) => Number.isFinite(date) && date >= +now - 30 * DAY && date <= +now;
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] : null;
}
function common(now, env) {
  return {schemaVersion:1, environment:env, source:'firestore-server-records',
    window_start:new Date(+now - 30*DAY), window_end:now, updated_at:now};
}

// Client observations are separate from the publication command and its receipt.
// Terminal observations never change when an older start is delivered later.
async function recordCreationAttempt(db, uid, input, now = new Date()) {
  documentId(input.attemptId, 'attemptId'); documentId(input.requestId, 'requestId');
  requireThat(['start','result','reconcile'].includes(input.phase), 'invalid-argument', 'Invalid observation phase.');
  const started = new Date(input.startedAt);
  requireThat(typeof input.startedAt === 'string' && Number.isFinite(+started) &&
    +started <= +now + 5*60000 && +started >= +now - 31*DAY,
  'invalid-argument', 'Supply a recent start timestamp.');
  if (input.phase !== 'start') {
    requireThat(['success','failure','timeout'].includes(input.outcome), 'invalid-argument', 'Invalid outcome.');
    integer(input.durationMs,0,7*DAY,'durationMs');
    requireThat(input.phase !== 'reconcile' || input.outcome !== 'timeout', 'invalid-argument', 'Invalid reconciliation.');
  }
  requireThat(input.errorCode === undefined || typeof input.errorCode === 'string' &&
    /^[a-z0-9-]{1,64}$/.test(input.errorCode), 'invalid-argument', 'Invalid error code.');
  const key = createHash('sha256').update(`${uid}/${input.attemptId}`).digest('hex');
  const ref = db.doc(`creationAttempts/${key}`);
  return db.runTransaction(async tx => {
    const old = (await tx.get(ref)).data();
    requireThat(!old || old.requestId === input.requestId && ms(old.startedAt) === +started,
      'already-exists', 'Attempt key already belongs to another request.');
    const changes = {};
    if (input.phase === 'result') {
      requireThat(!old?.outcome || old.outcome === input.outcome && old.durationMs === input.durationMs,
        'already-exists', 'Attempt observation is immutable.');
      Object.assign(changes, {outcome:input.outcome, durationMs:input.durationMs,
        errorCode:input.errorCode || null});
    }
    if (input.phase === 'reconcile') {
      requireThat(!old?.remoteOutcome || old.remoteOutcome === input.outcome,
        'already-exists', 'Reconciliation is immutable.');
      Object.assign(changes, {remoteOutcome:input.outcome, remoteDurationMs:input.durationMs});
    }
    tx.set(ref, {uid, attemptId:input.attemptId, requestId:input.requestId, startedAt:started,
      receivedAt:old?.receivedAt || now, environment:environment(db), platform:'flutter', ...changes}, {merge:true});
    return {recorded:true};
  });
}

function buildCreationInsight(records, now = new Date(), env = 'production') {
  const unique = new Map(records.filter(r => r.environment === env && inWindow(ms(r.startedAt),now))
    .map(r => [`${r.uid}/${r.attemptId}`, r]));
  const counts = {success:0,failure:0,timeout:0,unresolved:0};
  let reconciledSuccess = 0, reconciledFailure = 0;
  const durations = [], categories = {business:0,network:0,other:0};
  for (const r of unique.values()) {
    const state = Object.hasOwn(counts,r.outcome) ? r.outcome : 'unresolved';
    counts[state]++;
    if (Number.isFinite(r.durationMs)) durations.push(r.durationMs);
    if (r.outcome === 'timeout' && r.remoteOutcome === 'success') reconciledSuccess++;
    if (r.outcome === 'timeout' && r.remoteOutcome === 'failure') reconciledFailure++;
    if (state === 'failure') categories[['permission-denied','invalid-argument','failed-precondition','already-exists','unauthenticated'].includes(r.errorCode) ? 'business' :
      ['unavailable','network-request-failed','cancelled'].includes(r.errorCode) ? 'network' : 'other']++;
  }
  const attempts = unique.size;
  return {...common(now,env), attempts, ...counts, failure_or_timeout_pct:pct(counts.failure+counts.timeout,attempts),
    failure_pct:pct(counts.failure,attempts), timeout_pct:pct(counts.timeout,attempts),
    coverage_pct:pct(attempts-counts.unresolved,attempts), p95_duration_ms:percentile(durations,.95),
    logical_publications:new Set([...unique.values()].map(r=>`${r.uid}/${r.requestId}`)).size,
    reconciled_success:reconciledSuccess,reconciled_failure:reconciledFailure, failure_categories:categories,
    deadline_ms:8000, measurement:'client-network-attempts',
    limitation:'Only uploaded client observations are covered; local validation/storage/offline blocks are excluded.'};
}

function segment(size) { return size < 2 ? 'solo' : size <= 3 ? '2-3' : size <= 6 ? '4-6' : '7+'; }
function slotSegment(start, size, category) {
  const date = asDate(start);
  if (!date || !Number.isFinite(+date)) return null;
  const day = localDate(date), minute = (+date-dayStart(day))/60000;
  return {size:segment(size), category:category || 'other',
    weekday:new Date(`${day}T12:00:00Z`).getUTCDay(),
    bucket:minute < 720 ? 'morning' : minute < 1080 ? 'afternoon' : 'evening'};
}
function segmentKey(row) { return `${row.size}/${row.category}/${row.weekday}/${row.bucket}`; }
// Freeze the attribution at FIRST confirmation; later edits cannot manufacture a conversion.
function confirmationAttribution(activity) {
  const attribution = activity?.recommendationAttribution;
  if (!attribution || ms(activity.startTime) !== ms(attribution.startTime) ||
    ms(activity.endTime) !== ms(attribution.endTime)) return null;
  return attribution;
}
function buildConfirmationInsight(records, measurements, now = new Date(), env = 'production') {
  const rows = new Map(), batches = new Map(), unique = new Map();
  for (const r of records) {
    if (!r.id || !r.presentedAt || !inWindow(ms(r.presentedAt),now) ||
      (r.environment || 'production') !== env) continue;
    unique.set(r.id,r);
    const key = `${r.activityId}/${r.batchId}`;
    batches.set(key,Math.min(batches.get(key) ?? Infinity,ms(r.batchPresentedAt) || ms(r.presentedAt)));
  }
  let unknown = 0, pending = 0, matured = 0, confirmed = 0, cancelled = 0;
  for (const r of unique.values()) {
    const anchor = batches.get(`${r.activityId}/${r.batchId}`);
    const group = r.schemaVersion >= 2 && Number.isInteger(r.groupSize) ? slotSegment(r.startTime,r.groupSize,r.category) : null;
    if (!group) { unknown++; continue; }
    if (anchor + DAY > +now) { pending++; continue; }
    const measurement = measurements.get(r.activityId);
    const confirmation = ms(measurement?.firstConfirmedAt), attribution = measurement?.confirmationRecommendation;
    const selected = r.outcome === 'ACCEPTED_UNCHANGED';
    // A missing historical confirmation projection is unknown, not a failed
    // conversion. Explicit null snapshots mean the server checked the interval.
    if (selected && (!measurement || !Object.hasOwn(measurement,'firstConfirmedAt') ||
      confirmation >= ms(r.decidedAt) && confirmation <= anchor + DAY &&
      !Object.hasOwn(measurement,'confirmationRecommendation'))) { unknown++; continue; }
    matured++;
    const key = segmentKey(group), row = rows.get(key) || {...group,opportunities:0,confirmed:0,cancelled:0};
    row.opportunities++;
    // Generated/selected/accepted are not confirmation, nor are all the candidates in the same batch.
    const converted = r.outcome === 'ACCEPTED_UNCHANGED' && attribution?.candidateId === r.id &&
      attribution.batchId === r.batchId && ms(attribution.startTime) === ms(r.startTime) &&
      ms(attribution.endTime) === ms(r.endTime) && confirmation >= ms(r.decidedAt) &&
      confirmation >= anchor && confirmation <= anchor + DAY;
    if (converted) { row.confirmed++; confirmed++; }
    if (measurement?.cancelled) { row.cancelled++; cancelled++; }
    rows.set(key,row);
  }
  return {...common(now,env), opportunities:unique.size, mature_opportunities:matured, confirmed,
    pending, unknown, cancelled, coverage_pct:pct(unique.size-unknown,unique.size), confirmation_rate:pct(confirmed,matured),
    observation_hours:24, observation_anchor:'first-presentation-in-batch', minimum_sample:MIN_SAMPLE,
    by_segment:[...rows.values()].map(r=>({...r,confirmation_rate:pct(r.confirmed,r.opportunities)})),
    definition:'First activity confirmation within 24h of batch exposure, selected unchanged candidate only. This is not RSVP consensus.'};
}
function rankWithHistory(slots, context, insight, category, now = new Date(), env = 'production') {
  const fresh = insight && (insight.environment || 'production') === env &&
    ms(insight.updated_at) >= +now - 2*DAY && ms(insight.updated_at) <= +now;
  const histories = new Map((fresh ? insight.by_segment || [] : []).map(r=>[segmentKey(r),r]));
  const ranked = slots.map((slot,index)=>{
    const group=slotSegment(new Date(dayStart(context.date)+slot.start*60000),context.members.length,category);
    const history=histories.get(segmentKey(group));
    const enough=history?.opportunities >= MIN_SAMPLE && Number.isFinite(history.confirmation_rate);
    return {...slot, baseOrder:index, historicalRate:enough ? history.confirmation_rate : null,
      reasons:[...slot.reasons, enough ? `Historical confirmation ${history.confirmation_rate}% (${history.opportunities} opportunities, similar groups)` :
        'Base ranking: insufficient recent confirmation history for similar groups']};
  });
  // Unknown segments keep their base positions. Reorder only comparable,
  // measured slots; this also avoids a non-transitive mixed comparator.
  const comparable=ranked.filter(r=>r.historicalRate !== null)
    .sort((a,b)=>b.historicalRate-a.historicalRate || a.baseOrder-b.baseOrder);
  let next=0;
  return ranked.map(r=>r.historicalRate === null ? r : comparable[next++]);
}

async function refreshActivityInsights(db, now = new Date()) {
  const env=environment(db), since=new Date(+now-30*DAY);
  const [attempts, candidates] = await Promise.all([
    db.collection('creationAttempts').where('startedAt','>=',since).get(),
    db.collection('slotRecommendations').where('presentedAt','>=',since).where('presentedAt','<=',now).get(),
  ]);
  const records=candidates.docs.map(d=>({id:d.id,...d.data()}));
  const ids=[...new Set(records.map(r=>r.activityId))], measurements=new Map();
  for(let i=0;i<ids.length;i+=200) {
    const chunk=ids.slice(i,i+200);
    const [m,a]=await Promise.all([db.getAll(...chunk.map(id=>db.doc(`coordinationMeasurements/${id}`))),
      db.getAll(...chunk.map(id=>db.doc(`activities/${id}`)))]);
    chunk.forEach((id,j)=>measurements.set(id,{...m[j].data(),cancelled:a[j].data()?.cancelled === true}));
  }
  const creation=buildCreationInsight(attempts.docs.map(d=>d.data()),now,env);
  const confirmation=buildConfirmationInsight(records,measurements,now,env);
  const {buildRecommendationInsight}=require('./insights');
  const bq3={...buildRecommendationInsight(records.filter(r=>r.environment !== 'test' || env === 'test')),...common(now,env)};
  await Promise.all([db.doc('insights/bq2_creation_reliability').set(creation),
    db.doc('insights/bq13_recommendation_confirmation').set(confirmation),db.doc('insights/bq3_slot_acceptance').set(bq3)]);
  const reminder=await require('./reminderInsights').refreshReminderInsight(db,now);
  return {attempts:creation.attempts, opportunities:confirmation.opportunities,reminder_activities:reminder.total};
}
module.exports={recordCreationAttempt,buildCreationInsight,buildConfirmationInsight,refreshActivityInsights,
  confirmationAttribution,rankWithHistory,slotSegment,segmentKey,MIN_SAMPLE,environment};
