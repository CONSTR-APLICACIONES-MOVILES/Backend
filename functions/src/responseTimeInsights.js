const {buildResponseTimeInsight} = require('./insights');
const {asDate} = require('./coordinationInsights');
const DAY = 86400000;
const average = values => values.length ? Math.round(values.reduce((a,b) => a+b,0) / values.length / 6000) / 10 : null;

function responseTimeRows(invitations) {
  const sizes = new Map();
  for (const item of invitations) {
    if (!Number.isInteger(item.groupSize) || item.groupSize < 2 || item.expectedResponders < 1) continue;
    const first = new Map();
    for (const r of item.responses) {
      if (!r.responder || !Number.isFinite(r.responseMs) || r.responseMs < 0) continue;
      first.set(r.responder, Math.min(first.get(r.responder) ?? Infinity, r.responseMs));
    }
    const size = sizes.get(item.groupSize) || {group_size:item.groupSize, invitations:0, all:[], answers:[]};
    size.invitations++;
    size.answers.push(...first.values());
    if (first.size >= item.expectedResponders) size.all.push(Math.max(...first.values()));
    sizes.set(item.groupSize,size);
  }
  return [...sizes.values()].sort((a,b) => a.group_size-b.group_size).map(s => {
    const sorted = [...s.all].sort((a,b) => a-b);
    const median = sorted.length ? sorted[Math.floor((sorted.length-1)/2)] : null;
    return {group_size:s.group_size, invitations:s.invitations, completed:s.all.length,
      pct_completed:100*s.all.length/s.invitations, responses:s.answers.length,
      avg_minutes_all_responded:average(s.all), avg_minutes_per_response:average(s.answers),
      median_minutes_all_responded:median === null ? null : Math.round(median/6000)/10};
  });
}

async function refreshResponseTimeInsight(db, now = new Date()) {
  const since = new Date(now.getTime()-30*DAY);
  const snapshot = await db.collection('activities').where('createdAt','>=',since).where('createdAt','<',now).get();
  const invitations = [];
  for (const doc of snapshot.docs) {
    const activity = doc.data();
    if (activity.analyticsEnvironment === 'test') continue;
    let ids = activity.participantIds;
    if (!Array.isArray(ids)) ids = (await db.doc(`groups/${activity.groupId}`).get()).data()?.memberIds || [];
    ids = [...new Set(ids)];
    const invited = ids.filter(id => id !== activity.createdBy);
    if (!invited.length) continue;
    const records = await db.getAll(...invited.map(id => db.doc(`inboxes/${id}/items/${doc.id}`)));
    const responses = [];
    records.forEach((record,i) => {
      const data = record.data(), at = asDate(data?.respondedAt);
      if (data?.response && at && at <= now && Number.isFinite(data.responseMs)) responses.push({responder:invited[i], responseMs:data.responseMs});
    });
    invitations.push({activityId:doc.id, groupSize:ids.length, expectedResponders:invited.length, responses});
  }
  const insight = {...buildResponseTimeInsight(responseTimeRows(invitations)),
    source:'firestore-server-invitations', window_start:since, window_end:now, updated_at:now};
  await db.doc('insights/bq5_response_time').set(insight);
  return insight;
}
module.exports = {responseTimeRows, refreshResponseTimeInsight};
