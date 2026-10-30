const {createHash}=require('node:crypto');
const {asDate}=require('./coordinationInsights');
const DAY=86400000, MINUTE=60000;
const strategies=['single_after_30_min','single_after_60_min'];
const stamp=v=>asDate(v)?.getTime();
const sizeBucket=n=>n<=3?'2-3':n<=6?'4-6':'7+';
const percent=(n,d)=>d?Math.round(10000*n/d)/100:null;
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
const environment=db=>db.projectId?.startsWith('demo-')?'test':'production';

function chooseReminderPolicy(activityId,size,now,insight,env='production') {
  const bucket=sizeBucket(size);
  const winner=insight?.environment===env && stamp(insight.updated_at)>=+now-2*DAY && stamp(insight.updated_at)<=+now &&
    insight.decisions?.find(d=>d.size===bucket && strategies.includes(d.strategy) && d.sufficient);
  const strategy=winner?.strategy || strategies[parseInt(createHash('sha256').update(activityId).digest('hex').slice(0,8),16)%2];
  return {strategy,delayMinutes:strategy===strategies[0]?30:60,groupSize:size,size:bucket,
    assignedAt:now,assignment:winner?'observed-dominance':'balanced-hash',channel:'in-app',version:1};
}

// One Firestore transaction per reminder. Concurrent schedulers cannot create
// the same delivery or increment its counter twice. No push claim is made.
async function dispatchReminder(db,ref,now=new Date()) {
  return db.runTransaction(async tx=>{
    const reminder=(await tx.get(ref)).data();
    if(!reminder || reminder.status!=='SCHEDULED' || stamp(reminder.scheduledAt)>+now)return false;
    const parts=ref.path.split('/'),uid=parts[1],activityId=parts[3];
    const inboxRef=db.doc(`inboxes/${uid}/items/${activityId}`),activityRef=db.doc(`activities/${activityId}`);
    const inbox=(await tx.get(inboxRef)).data(),activity=(await tx.get(activityRef)).data();
    const group=activity?(await tx.get(db.doc(`groups/${activity.groupId}`))).data():null;
    const measurement=(await tx.get(db.doc(`coordinationMeasurements/${activityId}`))).data();
    const rsvp=reminder.purpose==='rsvp';
    const personal=reminder.purpose==='activity' && activity?.createdBy===uid;
    const close=reminder.closesAt?stamp(reminder.closesAt):Math.min(stamp(activity?.startTime)||Infinity,(stamp(inbox?.invitedAt)||+now)+DAY);
    const cancelled=!activity || activity.cancelled || !group?.memberIds?.includes(uid) ||
      (!rsvp && !personal) || (rsvp && (!inbox || !!inbox.response || activity.status==='CONFIRMED' ||
        !!measurement?.firstConfirmedAt || +now>=close || activity.participantIds && !activity.participantIds.includes(uid)));
    if(cancelled){tx.update(ref,{status:'CANCELLED',cancelledAt:now});return false;}
    const eventId=`reminder-${activityId}-${reminder.sequence||1}`;
    tx.set(db.doc(`alertEvents/${uid}/items/${eventId}`),{activityId,groupId:activity.groupId,kind:'reminder',
      title:personal?`Upcoming activity: ${activity.title}`:`Pending response: ${activity.title}`,
      description:[activity.date,activity.time,activity.location].filter(Boolean).join(' · '),
      createdAt:now,purpose:reminder.purpose,strategy:reminder.strategy,sequence:reminder.sequence||1,channel:'in-app'});
    tx.update(ref,{status:'SENT',sentAt:now});
    tx.set(inboxRef,{reminderCount:(inbox?.reminderCount||0)+1,lastReminderAt:now,lastReminderStrategy:reminder.strategy},{merge:true});
    if(rsvp)tx.set(db.doc(`reminderDeliveries/${createHash('sha256').update(ref.path).digest('hex')}`),{
      activityId,recipientId:uid,strategy:reminder.strategy,sequence:reminder.sequence||1,sentAt:now,
      environment:environment(db),purpose:'rsvp',channel:'in-app'});
    return true;
  });
}
async function dispatchPendingReminders(db,now=new Date()) {
  const pending=await db.collectionGroup('reminders').where('status','==','SCHEDULED').where('scheduledAt','<=',now).limit(200).get();
  let dispatched=0;
  // Bounded writes per transaction rather than a 500-document batch with >500 writes.
  for(const reminder of pending.docs) if(await dispatchReminder(db,reminder.ref,now))dispatched++;
  return {checked:pending.size,dispatched};
}

function buildReminderInsight(records,measurements,deliveries,now=new Date(),env='production') {
  const rows=new Map(),seen=new Set();let pending=0,unknown=0,total=0;
  const sent=new Map();
  for(const d of deliveries){
    if(d.environment!==env || d.purpose!=='rsvp')continue;
    const key=`${d.activityId}/${d.recipientId}/${d.strategy}/${d.sequence}`;
    if(seen.has(key))continue;seen.add(key);
    sent.set(d.activityId,[...(sent.get(d.activityId)||[]),d]);
  }
  for(const r of records){
    const invited=stamp(r.invitedAt);
    if(r.environment!==env || !Number.isFinite(invited) || invited<+now-30*DAY || invited>+now)continue;
    total++;
    if(!strategies.includes(r.strategy) || !(r.groupSize>=2)){unknown++;continue;}
    if(invited+DAY>+now){pending++;continue;}
    const measurement=measurements.get(r.activityId);
    if(!measurement || !Object.hasOwn(measurement,'firstConfirmedAt')){unknown++;continue;}
    const confirmedAt=stamp(measurement.firstConfirmedAt),confirmed=confirmedAt>=invited && confirmedAt<=invited+DAY &&
      (!r.cancelledAt || confirmedAt<=stamp(r.cancelledAt));
    const close=Math.min(confirmed?confirmedAt:Infinity,stamp(r.cancelledAt)||Infinity,invited+DAY);
    const alerts=(sent.get(r.activityId)||[]).filter(d=>d.strategy===r.strategy && stamp(d.sentAt)>=invited && stamp(d.sentAt)<=close).length;
    const size=sizeBucket(r.groupSize),key=`${size}/${r.strategy}`;
    const row=rows.get(key)||{size,strategy:r.strategy,activities:0,confirmed:0,notifications:0,notifications_for_confirmed:0,times:[],initially_confirmed:0};
    row.activities++;row.notifications+=alerts;
    if(r.initiallyConfirmed)row.initially_confirmed++;
    if(confirmed){row.confirmed++;row.notifications_for_confirmed+=alerts;row.times.push((confirmedAt-invited)/MINUTE);}
    rows.set(key,row);
  }
  const result=[...rows.values()].map(({times,...r})=>({...r,confirmation_rate:percent(r.confirmed,r.activities),
    median_minutes:quantile(times,.5),p95_minutes:quantile(times,.95),
    notifications_per_activity:r.notifications/r.activities,
    notifications_per_confirmed:r.confirmed?r.notifications/r.confirmed:null}));
  const decisions=['2-3','4-6','7+'].map(size=>{
    const a=result.find(r=>r.size===size&&r.strategy===strategies[0]),b=result.find(r=>r.size===size&&r.strategy===strategies[1]);
    const sufficient=!!(a&&b&&a.activities>=20&&b.activities>=20&&a.confirmed>=5&&b.confirmed>=5&&
      a.initially_confirmed===0&&b.initially_confirmed===0);
    const dominates=(x,y)=>x.confirmation_rate>=y.confirmation_rate && x.median_minutes<y.median_minutes && x.notifications_per_activity<=y.notifications_per_activity;
    const winner=sufficient?(dominates(a,b)?a:dominates(b,a)?b:null):null;
    return {size,sufficient:!!winner,strategy:winner?.strategy||null,
      reason:winner?'observed-dominance':'insufficient sample or no clear joint improvement'};
  });
  return {schemaVersion:1,environment:env,source:'firestore-server-records',window_start:new Date(+now-30*DAY),window_end:now,updated_at:now,
    total,pending,unknown,mature_activities:result.reduce((n,r)=>n+r.activities,0),by_strategy_size:result,decisions,
    observation_hours:24,channel:'in-app',minimum_sample_per_strategy:20,
    definition:'Activity first CONFIRMED from invitation, not RSVP consensus; observational comparison, not a causal claim.'};
}
async function refreshReminderInsight(db,now=new Date()){
  const since=new Date(+now-30*DAY);
  const [cohort,deliveries]=await Promise.all([db.collection('reminderMeasurements').where('invitedAt','>=',since).get(),
    db.collection('reminderDeliveries').where('sentAt','>=',since).get()]);
  const records=cohort.docs.map(d=>({activityId:d.id,...d.data()})),measurements=new Map();
  for(let i=0;i<records.length;i+=200){
    const chunk=records.slice(i,i+200);
    const [m,a]=await Promise.all([db.getAll(...chunk.map(r=>db.doc(`coordinationMeasurements/${r.activityId}`))),db.getAll(...chunk.map(r=>db.doc(`activities/${r.activityId}`)))]);
    chunk.forEach((r,j)=>{measurements.set(r.activityId,m[j].data());r.cancelledAt=a[j].data()?.cancelledAt;});
  }
  const insight=buildReminderInsight(records,measurements,deliveries.docs.map(d=>d.data()),now,environment(db));
  await db.doc('insights/bq14_reminder_effectiveness').set(insight);return insight;
}
module.exports={chooseReminderPolicy,dispatchReminder,dispatchPendingReminders,buildReminderInsight,refreshReminderInsight};
