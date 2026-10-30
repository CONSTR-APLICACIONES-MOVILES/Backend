const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCoordinationInsight, cohortWindow, prepareProposalComparison, consumeComparison,
  recordFirstConfirmation, refreshCoordinationInsight} = require('../src/coordinationInsights');
const {responseTimeRows} = require('../src/responseTimeInsights');
const {createMobileCallables} = require('../src/mobileCallables');
const {MobileService} = require('../src/mobileService');
const {ActivityLifecycle} = require('../src/activityLifecycle');
const flutterPayloads = require('./fixtures/flutter-publication.json');
const now = new Date('2026-10-29T15:00:00Z');
const DAY = 86400000;
function dates(value) {
  if (value instanceof Date) return {toDate:() => new Date(value)};
  if (Array.isArray(value)) return value.map(dates);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,dates(v)]));
  return value;
}
// Transaction double enforces Firestore read-before-write and commits only after success.
class DB {
  constructor() { this.rows = new Map(); }
  doc(path) { return {path, get:async () => this.snapshot(path), set:async data => this.rows.set(path,data)}; }
  snapshot(path) { const data = this.rows.get(path); return {id:path.split('/').at(-1), exists:!!data, data:() => dates(data), updateTime:{seconds:1,nanoseconds:0}}; }
  collection(path) {
    const filters = [];
    const query = {path, where:(...filter) => { filters.push(filter); return query; }, get:async () => ({docs:[...this.rows.keys()]
      .filter(p => p.startsWith(`${path}/`) && !p.slice(path.length+1).includes('/'))
      .filter(p => filters.every(([field,op,value]) => { const actual=this.rows.get(p)[field];
        return op==='array-contains' ? actual?.includes(value) : op==='>=' ? actual>=value : op==='<' ? actual<value : actual===value; }))
      .map(p => this.snapshot(p))})};
    return query;
  }
  async getAll(...refs) { return refs.map(ref => this.snapshot(ref.path)); }
  async runTransaction(work) {
    let wrote = false;
    const writes = [];
    const tx = {get:async ref => { assert.equal(wrote,false,'transaction read after write'); return ref.path && !ref.where ? this.snapshot(ref.path) : ref.get(); },
      getAll:async (...refs) => { assert.equal(wrote,false); return this.getAll(...refs); }};
    for (const method of ['set','create','update']) tx[method] = (ref,data,options) => { wrote=true; writes.push({method,ref,data,options}); };
    const result = await work(tx);
    for (const {method,ref,data,options} of writes) {
      if (method==='create') assert.equal(this.rows.has(ref.path),false,'duplicate create');
      this.rows.set(ref.path, method==='update' || options?.merge ? {...this.rows.get(ref.path),...data} : data);
    }
    return result;
  }
}
function setup() {
  const db=new DB();
  db.rows.set('groups/g',{memberIds:['owner','peer'],members:[{id:'owner',busy:[]},{id:'peer',busy:[{start:0,end:1440}]}]});
  return db;
}
const proposal = {date:'2026-10-29',friendIds:['peer']};
const publication = {requestId:'req',groupId:'g',measurementVersion:1,fields:{title:'QA',status:'PROPOSED'}};

test('BQ9 rates, unknown coverage, seven-day boundary, fixtures and empty denominators', () => {
  const createdAt=new Date('2026-10-10T15:00:00Z');
  const row=(activityId,comparisonUsed,days) => ({activityId,comparisonUsed,createdAt,firstConfirmedAt:days==null?null:new Date(+createdAt+days*DAY)});
  const result=buildCoordinationInsight([row('a',true,7),row('b',true,0),row('c',false,1),row('d',false,8),row('e',null,null),
    {...row('fixture',true,0),environment:'test'}, {...row('young',true,0),createdAt:now}],now);
  assert.equal(result.total,5); assert.equal(result.coverage,.8); assert.equal(result.comparisonUsage,.5);
  assert.equal(result.compared.confirmationRate,1); assert.equal(result.direct.confirmationRate,.5); assert.equal(result.differencePp,50);
  const empty=buildCoordinationInsight([],now); assert.equal(empty.coverage,null); assert.equal(empty.differencePp,null);
});
test('cohort uses complete Bogota days and excludes upper boundary', () => {
  const {start,end}=cohortWindow(new Date('2026-10-29T02:00:00Z'));
  assert.equal(end.toISOString(),'2026-10-21T05:00:00.000Z'); assert.equal(+end-+start,30*DAY);
  assert.equal(buildCoordinationInsight([{activityId:'edge',createdAt:end}],new Date('2026-10-29T02:00:00Z')).total,0);
});
test('proposal evidence accepts a known busy day without claiming a free slot', async () => {
  const db=setup(), result=await prepareProposalComparison(db,'owner',proposal,now);
  assert.deepEqual(result.participantIds,['owner','peer']); assert.ok(db.rows.has(`coordinationComparisons/${result.comparisonEvidenceId}`));
});
test('proposal rejects strangers, duplicate peers, unknown schedules and private schedules', async () => {
  const db=setup();
  await assert.rejects(prepareProposalComparison(db,'owner',{...proposal,friendIds:['stranger']},now),{code:'permission-denied'});
  await assert.rejects(prepareProposalComparison(db,'owner',{...proposal,friendIds:['peer','peer']},now),{code:'invalid-argument'});
  await assert.rejects(prepareProposalComparison(db,'owner',{...proposal,date:'2026-10-30'},now),{code:'failed-precondition'});
  db.rows.set('profiles/peer',{preferences:{scheduleVisibility:'private'}});
  await assert.rejects(prepareProposalComparison(db,'owner',proposal,now),{code:'permission-denied'});
  assert.equal([...db.rows.keys()].filter(k => k.startsWith('coordinationComparisons/')).length,0);
});
test('publishing consumes evidence atomically and replay returns one measured activity', async () => {
  const db=setup(), comparison=await prepareProposalComparison(db,'owner',proposal,now);
  const lifecycle=new ActivityLifecycle(db,{clock:() => now});
  const input={...publication,comparisonEvidenceId:comparison.comparisonEvidenceId,participantIds:comparison.participantIds};
  const receipt=await lifecycle.publishActivity('owner',input);
  assert.deepEqual(await lifecycle.publishActivity('owner',input),receipt);
  assert.equal(db.rows.get(`coordinationMeasurements/${receipt.activityId}`).comparisonUsed,true);
  assert.equal(db.rows.get(`coordinationComparisons/${comparison.comparisonEvidenceId}`).consumedBy,receipt.activityId);
  await assert.rejects(lifecycle.publishActivity('owner',{...input,requestId:'second'}),{code:'failed-precondition'});
});
test('direct instrumented publication is false, legacy is unknown, unsupported schema fails', async () => {
  const db=setup(), service=new ActivityLifecycle(db,{clock:() => now});
  const direct=await service.publishActivity('owner',publication);
  const legacy=await service.publishActivity('owner',{...publication,requestId:'legacy',measurementVersion:undefined});
  assert.equal(db.rows.get(`coordinationMeasurements/${direct.activityId}`).comparisonUsed,false);
  assert.equal(db.rows.get(`coordinationMeasurements/${legacy.activityId}`).comparisonUsed,null);
  await assert.rejects(service.publishActivity('owner',{...publication,requestId:'bad',measurementVersion:2}),{code:'invalid-argument'});
});
test('validated scheduled slot produces evidence and publication retains selected instants', async () => {
  const db=setup(); db.rows.get('groups/g').members[1].busy=[];
  const service=new ActivityLifecycle(db,{clock:() => now});
  const slot={participantIds:['peer'],groupId:'g',startTime:'2026-10-29T16:00:00.000Z',endTime:'2026-10-29T17:00:00.000Z',timeZone:'America/Bogota'};
  const comparison=await service.validatePlanningSlot('owner',slot);
  assert.equal(comparison.comparisonEvidenceId,comparison.comparisonId);
  const receipt=await service.publishActivity('owner',{...publication,...slot,participantIds:comparison.participantIds,
    comparisonId:comparison.comparisonId,comparisonEvidenceId:comparison.comparisonEvidenceId});
  assert.equal(receipt.startTime,slot.startTime);
  assert.equal(db.rows.get(`coordinationMeasurements/${receipt.activityId}`).comparisonUsed,true);
});
test('creation already confirmed and later reconfirmation preserve the earliest confirmation', async () => {
  const db=setup(); let clock=now;
  const service=new ActivityLifecycle(db,{clock:() => clock});
  const receipt=await service.publishActivity('owner',{...publication,fields:{title:'QA',status:'CONFIRMED'}});
  const ref=`coordinationMeasurements/${receipt.activityId}`;
  assert.equal(+db.rows.get(ref).firstConfirmedAt,+now);
  const mutate=status => service.mutate('owner',{activityId:receipt.activityId,expectedVersion:'1:0',fields:{title:'QA',status}},false);
  clock=new Date(+now+60000); await mutate('PROPOSED');
  clock=new Date(+now+120000); await mutate('CONFIRMED');
  assert.equal(+db.rows.get(ref).firstConfirmedAt,+now);
});
test('evidence checks owner, expiry, participants and date before publication', async () => {
  const db=setup(), evidence=await prepareProposalComparison(db,'owner',proposal,now);
  const input={...publication,...evidence};
  for (const [uid,ids,clock,date] of [['peer',['owner','peer'],now,proposal.date],['owner',['owner'],now,proposal.date],
    ['owner',['owner','peer'],new Date(+now+31*60000),proposal.date],['owner',['owner','peer'],now,'2026-10-30']]) {
    await assert.rejects(db.runTransaction(tx => consumeComparison(db,tx,uid,input,ids,'activity',clock,date)),{code:'failed-precondition'});
  }
});
test('first confirmation keeps earliest timestamp across duplicate and out-of-order trigger deliveries', async () => {
  const db=setup(), createdAt=new Date('2026-10-01T15:00:00Z');
  const after={createdAt,status:'CONFIRMED'};
  await recordFirstConfirmation(db,'activity',{status:'PROPOSED'},after,new Date('2026-10-05T15:00:00Z'));
  await recordFirstConfirmation(db,'activity',{status:'PROPOSED'},after,new Date('2026-10-03T15:00:00Z'));
  await recordFirstConfirmation(db,'activity',{status:'PROPOSED'},after,new Date('2026-10-05T15:00:00Z'));
  assert.equal(db.rows.get('coordinationMeasurements/activity').firstConfirmedAt.toISOString(),'2026-10-03T15:00:00.000Z');
});
test('aggregate includes uninstrumented historical activities as unknown', async () => {
  const db=setup(); db.rows.set('activities/old',{createdAt:new Date('2026-10-10T15:00:00Z')});
  const result=await refreshCoordinationInsight(db,now);
  assert.equal(result.total,1); assert.equal(result.unknown,1); assert.equal(result.comparisonUsage,null);
});
test('new callable contracts enforce authentication and reject unexpected fields', async () => {
  const db=setup(), api=createMobileCallables(new MobileService(db,{clock:() => now}));
  await assert.rejects(api.getCoordinationInsight.run({data:{}}),{code:'unauthenticated'});
  await assert.rejects(api.prepareProposalComparison.run({auth:{uid:'owner'},data:{...proposal,uid:'peer'}}),{code:'invalid-argument'});
  assert.deepEqual(await api.getCoordinationInsight.run({auth:{uid:'owner'},data:{}}),{insight:null});
  const response=await api.prepareProposalComparison.run({auth:{uid:'owner'},data:proposal}); assert.ok(response.comparisonEvidenceId);
});
test('BQ5 server acknowledgements deduplicate responders and account for organizer not being invited', () => {
  const rows=responseTimeRows([{groupSize:3,expectedResponders:2,responses:[{responder:'a',responseMs:60000},{responder:'a',responseMs:120000},{responder:'b',responseMs:180000}]},
    {groupSize:3,expectedResponders:2,responses:[]}]);
  assert.equal(rows[0].completed,1); assert.equal(rows[0].invitations,2); assert.equal(rows[0].responses,2);
  assert.equal(rows[0].avg_minutes_all_responded,3); assert.equal(rows[0].avg_minutes_per_response,2);
});
test('actual Flutter publication payloads pass the callable whitelist and persist measurement semantics', async () => {
  for (const [kind,input] of Object.entries(flutterPayloads)) {
    const db=setup(); db.rows.get('groups/g').members[1].busy=[];
    const evidenceId=input.comparisonEvidenceId;
    if (evidenceId) db.rows.set(`coordinationComparisons/${evidenceId}`,{
      uid:'owner',participantIds:['owner','peer'],date:'2026-10-29',groupId:'g',
      expiresAt:new Date(+now+5*60000),consumedBy:null,
    });
    if (input.comparisonId) db.rows.set(`planningComparisons/${input.comparisonId}`,{
      uid:'owner',participantIds:['owner','peer'],groupId:'g',startTime:input.startTime,endTime:input.endTime,
      expiresAt:new Date(+now+5*60000),
    });
    const api=createMobileCallables(new MobileService(db,{clock:() => now}));
    const receipt=await api.publishActivity.run({auth:{uid:'owner'},data:input});
    assert.equal(receipt.created,true,kind);
    assert.equal(db.rows.get(`coordinationMeasurements/${receipt.activityId}`).comparisonUsed,
      kind==='legacy' ? null : kind!=='direct',kind);
    assert.deepEqual(await api.publishActivity.run({auth:{uid:'owner'},data:input}),receipt,`${kind} replay`);
    await assert.rejects(api.publishActivity.run({auth:{uid:'owner'},data:{...input,unsupportedMeasurement:true}}),{code:'invalid-argument'});
  }
});
test('map location persists in publication, nested mutation retries are idempotent, legacy text edit clears coordinates', async()=>{
  const db=setup(),service=new ActivityLifecycle(db,{clock:()=>now});
  const locationDetails={latitude:4.6,longitude:-74.07,label:'Library',placeId:'place-1'};
  const receipt=await service.publishActivity('owner',{...publication,fields:{title:'Plan',location:'Library',locationDetails}});
  const path=`activities/${receipt.activityId}`;
  assert.deepEqual(db.rows.get(path).locationDetails,locationDetails);
  const update={activityId:receipt.activityId,expectedVersion:'1:0',fields:{title:'Updated',location:'Library',locationDetails}};
  await service.mutate('owner',update,false);
  assert.deepEqual(await service.mutate('owner',update,false),{activityId:receipt.activityId,cancelled:false,saved:true});
  await service.mutate('owner',{...update,fields:{title:'Updated',location:'Manual location'}},false);
  assert.equal(db.rows.get(path).locationDetails,null);
});
