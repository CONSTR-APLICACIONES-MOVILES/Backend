const {requireThat} = require('./errors');
const {localDate,dayStart} = require('./availability');
const {asDate} = require('./coordinationInsights');
const {buildCreationInsight,environment} = require('./activityInsights');
const {buildRecommendationInsight} = require('./insights');
const {buildReminderInsight} = require('./reminderInsights');
const {buildCoordinationAnalytics} = require('./coordinationAnalytics');
const DAY=86400000, MAX_ROWS=10000;
const sizes=['solo','2-3','4-6','7+','unknown'];
const sizeOf=n=>!Number.isInteger(n)||n<1?'unknown':n===1?'solo':n<=3?'2-3':n<=6?'4-6':'7+';
function date(value) {
  requireThat(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(dayStart(value)) && localDate(new Date(dayStart(value)))===value,
  'invalid-argument','Use valid YYYY-MM-DD dates.');
  return value;
}
function filters(input={},now=new Date()) {
  requireThat(['bq2','bq3','bq9','bq14'].includes(input.question),'invalid-argument','Choose BQ2, BQ3, BQ9 or BQ14.');
  const from=date(input.from ?? localDate(new Date(+now-29*DAY))), to=date(input.to ?? localDate(now));
  requireThat(from<=to && to<=localDate(now) && dayStart(to)-dayStart(from)<90*DAY,
    'invalid-argument','Choose an ordered range of at most 90 days, ending today or earlier.');
  const selected={question:input.question,from,to,granularity:input.granularity||'day',size:input.size||'all',
    category:input.category||'all',position:input.position??'all',strategy:input.strategy||'all',
    comparison:input.question==='bq9' ? input.comparison||'all' : 'all',
    confirmationDays:input.question==='bq9' ? input.confirmationDays ?? 7 : 7,
    excludeInitial:input.question==='bq14' ? input.excludeInitial ?? true : false};
  requireThat(typeof selected.excludeInitial==='boolean','invalid-argument','Invalid initial-confirmation filter.');
  requireThat(['day','week'].includes(selected.granularity) && ['all',...sizes].includes(selected.size) &&
    ['all','study','sports','social','other','unknown'].includes(selected.category) &&
    (selected.position==='all'||Number.isInteger(selected.position)&&selected.position>=0&&selected.position<10) &&
    ['all','single_after_30_min','single_after_60_min'].includes(selected.strategy),
  'invalid-argument','Unsupported analytics filter.');
  requireThat(['all','with_comparison','without_comparison','unknown'].includes(selected.comparison) &&
    [1,7,30].includes(selected.confirmationDays),
  'invalid-argument','Unsupported BQ9 comparison or confirmation window.');
  requireThat(input.question==='bq3'||selected.position==='all',
    'invalid-argument','Position applies only to BQ3.');
  requireThat(['bq3','bq9'].includes(input.question)||selected.category==='all',
    'invalid-argument','Category applies only to BQ3 or BQ9.');
  requireThat(input.question==='bq14'||selected.strategy==='all','invalid-argument','Strategy applies only to BQ14.');
  requireThat(input.question==='bq9'||(input.comparison===undefined&&input.confirmationDays===undefined),
    'invalid-argument','Comparison and confirmation window apply only to BQ9.');
  requireThat(input.question!=='bq2'||selected.size==='all','invalid-argument','Group size is not measured in creation telemetry.');
  return selected;
}
function groupDate(day, granularity) {
  if(granularity==='day')return day;
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
  return localDate(new Date(dayStart(day)-((weekday+6)%7)*DAY));
}

// Pure aggregation. No IDs, profiles, event bodies or individual durations leave
// the server. Filters refer to cohort start/exposure/invitation in Bogota.
function buildActivityAnalytics(source,input,now=new Date(),env='production') {
  const f=filters(input,now), range={from:dayStart(f.from),until:Math.min(dayStart(f.to)+DAY-1,+now)};
  if(f.question==='bq9') return buildCoordinationAnalytics(source.coordination||[],f,now,env);
  const timestamp=r=>asDate(f.question==='bq2'?r.startedAt:f.question==='bq3'?r.presentedAt:r.invitedAt)?.getTime();
  const candidates=f.question==='bq2'?source.attempts||[]:f.question==='bq3'?source.candidates||[]:source.reminders||[];
  const available=[...new Map(candidates.filter(r=>(r.environment||(f.question==='bq3'?'production':null))===env &&
    timestamp(r)>=range.from && timestamp(r)<=range.until).map((r,i)=>[
    f.question==='bq2'?`${r.uid}/${r.attemptId}`:f.question==='bq3'?r.id||`missing-${i}`:r.activityId||`missing-${i}`,r])).values()];
  const records=available.filter(r=>(f.size==='all'||sizeOf(r.groupSize)===f.size)&&
    (f.category==='all'||(r.category||'unknown')===f.category)&&
    (f.position==='all'||r.position===f.position)&&(f.strategy==='all'||r.strategy===f.strategy)&&
    (!f.excludeInitial||!r.initiallyConfirmed));
  const summarize=rows=>f.question==='bq2'?buildCreationInsight(rows,now,env,range):
    f.question==='bq3'?buildRecommendationInsight(rows):
      buildReminderInsight(rows,source.measurements||new Map(),source.deliveries||[],now,env,range);
  const buckets=new Map();
  for(let t=range.from;t<=range.until;t+=DAY)buckets.set(groupDate(localDate(new Date(t)),f.granularity),[]);
  for(const r of records)buckets.get(groupDate(localDate(new Date(timestamp(r))),f.granularity))?.push(r);
  const timeline=[...buckets].map(([date,rows])=>({date,...summarize(rows),
    ...(f.question==='bq14'?{strategies:Object.fromEntries(['single_after_30_min','single_after_60_min'].map(s=>[s,summarize(rows.filter(r=>r.strategy===s))]))}:{}),
  }));
  const summary=summarize(records);
  return {schemaVersion:1,question:f.question,filters:f,environment:env,updatedAt:now.toISOString(),
    available:available.length,matched:records.length,excludedByFilters:available.length-records.length,
    summary,timeline,
    explanation:f.question==='bq14'?'Cohorts by invitation date. Outcomes observed now, within 24 hours. Speed uses confirmed plans only. Sent means in-app, not push receipt. Observational, not causal.':
      f.question==='bq3'?'Cohorts by first exposure date. All presented candidates enter the denominator, including unselected ones. Acceptance is not activity confirmation.':
      'Cohorts by client attempt start date. Uploaded attempts only; local/offline validation blocks are excluded. Unresolved starts remain in the denominator.',
  };
}

async function getActivityAnalytics(db,input,now=new Date()) {
  const f=filters(input,now), from=new Date(dayStart(f.from)), until=new Date(Math.min(dayStart(f.to)+DAY-1,+now));
  if(f.question==='bq9') {
    const snapshot=await db.collection('activities').where('createdAt','>=',from).where('createdAt','<=',until)
        .limit(MAX_ROWS+1).get();
    requireThat(snapshot.size<=MAX_ROWS,'resource-exhausted','This range exceeds 10,000 activities. Choose a smaller range.');
    const rows=snapshot.docs.map(d=>({id:d.id,...d.data()})), coordination=[];
    for(let i=0;i<rows.length;i+=200) {
      const chunk=rows.slice(i,i+200);
      const measurements=await db.getAll(...chunk.map(r=>db.doc(`coordinationMeasurements/${r.id}`)));
      chunk.forEach((activity,j)=>{
        const measurement=measurements[j].data();
        coordination.push({
          activityId:activity.id,
          createdAt:activity.createdAt,
          category:activity.category,
          groupSize:activity.planningContext?.groupSizeAtCreation,
          comparisonUsed:measurement?.comparisonUsed ?? activity.planningContext?.comparisonUsed ?? null,
          firstConfirmedAt:measurement?.firstConfirmedAt ?? activity.confirmedAt ?? null,
          environment:activity.analyticsEnvironment==='test' ? 'test' :
            measurement?.environment || environment(db),
        });
      });
    }
    return buildActivityAnalytics({coordination},f,now,environment(db));
  }
  const name=f.question==='bq2'?'creationAttempts':f.question==='bq3'?'slotRecommendations':'reminderMeasurements';
  const field=f.question==='bq2'?'startedAt':f.question==='bq3'?'presentedAt':'invitedAt';
  const snapshot=await db.collection(name).where(field,'>=',from).where(field,'<=',until).limit(MAX_ROWS+1).get();
  requireThat(snapshot.size<=MAX_ROWS,'resource-exhausted','This range exceeds 10,000 records. Choose a smaller range.');
  const rows=snapshot.docs.map(d=>({id:d.id,...d.data()})), source={};
  if(f.question==='bq2')source.attempts=rows;
  else if(f.question==='bq3')source.candidates=rows;
  else {
    source.reminders=rows.map(r=>({...r,activityId:r.id}));
    source.measurements=new Map();
    for(let i=0;i<rows.length;i+=200){
      const chunk=rows.slice(i,i+200);
      const [measurements,activities]=await Promise.all([
        db.getAll(...chunk.map(r=>db.doc(`coordinationMeasurements/${r.id}`))),
        db.getAll(...chunk.map(r=>db.doc(`activities/${r.id}`)))]);
      chunk.forEach((r,j)=>{source.measurements.set(r.id,measurements[j].data());source.reminders[i+j].cancelledAt=activities[j].data()?.cancelledAt;});
    }
    const deliveries=await db.collection('reminderDeliveries').where('sentAt','>=',from)
      .where('sentAt','<=',new Date(Math.min(+until+DAY,+now))).limit(MAX_ROWS+1).get();
    requireThat(deliveries.size<=MAX_ROWS,'resource-exhausted','Too many reminder deliveries. Choose a smaller range.');
    source.deliveries=deliveries.docs.map(d=>d.data());
  }
  return buildActivityAnalytics(source,f,now,environment(db));
}
module.exports={getActivityAnalytics,buildActivityAnalytics,filters,groupDate};
