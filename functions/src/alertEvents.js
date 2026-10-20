const {createHash} = require('node:crypto');
const hash = v => createHash('sha256').update(v).digest('hex');
const iso = v => v ? (v.toDate ? v.toDate() : new Date(v)).toISOString() : null;
async function recordActivityChange(db, id, before, after, version, eventTime) {
  if (!before || !after) return;
  const changed = !!before.cancelled !== !!after.cancelled || iso(before.startTime) !== iso(after.startTime) || iso(before.endTime) !== iso(after.endTime) || before.date !== after.date || before.time !== after.time;
  if (!changed) return;
  const group = (await db.doc(`groups/${after.groupId}`).get()).data();
  if (!group) return;
  const eventId = hash(`${id}:${version}`), createdAt = eventTime || new Date(version);
  const batch = db.batch();
  for (const uid of after.participantIds || group.memberIds) if (uid !== after.createdBy && group.memberIds.includes(uid)) {
    batch.set(db.doc(`alertEvents/${uid}/items/${eventId}`), {activityId:id,groupId:after.groupId,kind:'timeChanged',title:after.cancelled?'Activity cancelled': 'Activity time changed',description:after.title,createdAt:Number.isFinite(createdAt.getTime())?createdAt:new Date()});
  }
  await batch.commit();
}
async function additionalAlerts(db,uid,groups,activities,now) {
  const authorized = new Map(groups.map(g=>[g.id,g.data()]));
  const [events,invites] = await Promise.all([db.collection(`alertEvents/${uid}/items`).orderBy('createdAt','desc').limit(100).get(),db.collection(`groupInvitations/${uid}/items`).orderBy('expiresAt','desc').limit(100).get()]);
  const rows=[];
  for (const doc of events.docs) {
    const e=doc.data(), group=authorized.get(e.groupId);
    if (!group) continue;
    const a=(await db.doc(`activities/${e.activityId}`).get()).data();
    if (!a || a.participantIds && !a.participantIds.includes(uid)) continue;
    rows.push({id:`evt_${doc.id}`,kind:e.kind,title:e.title,description:e.description,createdAt:iso(e.createdAt),studySessionId:e.activityId});
  }
  for (const doc of invites.docs) {
    const i=doc.data(); if(i.state!=='pending' || i.expiresAt.toDate()<=now || authorized.has(doc.id)) continue;
    rows.push({id:`grp_${hash(doc.id)}`,kind:'groupInvite',title:`Invitation to ${i.groupName}`,description:'Open group invitations to accept or decline.',createdAt:new Date(i.expiresAt.toDate().getTime()-7*86400000).toISOString(),groupId:doc.id,studySessionId:null});
  }
  for (const doc of activities) {
    const a=doc.data(), start=Date.parse(iso(a.startTime));
    if(a.cancelled || !a.startTime || start<=now.getTime() || start>now.getTime()+3600000 || a.createdBy!==uid && a.participantIds && !a.participantIds.includes(uid)) continue;
    rows.push({id:`rem_${hash(`${doc.id}:${iso(a.startTime)}`)}`,kind:'reminder',title:`Starts within an hour: ${a.title}`,description:[a.date,a.time,a.location].filter(Boolean).join(' · '),createdAt:new Date(start-3600000).toISOString(),studySessionId:doc.id});
  }
  if(!rows.length) return [];
  const states=await db.getAll(...rows.map(r=>db.doc(`inboxes/${uid}/items/${r.id}`)));
  return rows.map((r,i)=>({...r,isRead:states[i].data()?.isRead || false,response:null}));
}
module.exports={recordActivityChange,additionalAlerts};
