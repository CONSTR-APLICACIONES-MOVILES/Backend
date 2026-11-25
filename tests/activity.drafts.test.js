const test = require('node:test'), assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const req = createRequire(require.resolve('../functions/package.json'));
const {initializeApp, deleteApp} = req('firebase-admin/app');
const {getFirestore} = req('firebase-admin/firestore');
const {MobileService} = require('../functions/src/mobileService');
const {createMobileCallables} = require('../functions/src/mobileCallables');
const project = 'demo-parchapp-draft-contracts';
let app, db, api;
const call = (name, data, uid='alice') => api[name].run({data,auth:uid ? {uid} : undefined});
const payload = (title='Draft') => ({groupId:'',title,description:'',category:'study',location:'',status:'PROPOSED',date:'',time:''});
const save = extra => ({id:'draft',operationId:'op1',expectedVersion:0,state:'active',category:'study',payload:payload(),...extra});
test.before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Emulator required');
  app = initializeApp({projectId:project}, 'draft-contracts'); db = getFirestore(app);
  api = createMobileCallables(new MobileService(db));
});
test.beforeEach(async () => {
  const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, {method:'DELETE'});
  assert.ok(r.ok);
});
test.after(async () => {await db?.terminate(); if (app) await deleteApp(app);});

test('authenticated owner-only contract, incomplete fields and idempotent lost-response retries', async () => {
  await assert.rejects(call('syncActivityDraft',save(),null), {code:'unauthenticated'});
  await assert.rejects(call('syncActivityDraft',save({clientUserId:'bob'})), {code:'permission-denied'});
  const first = await call('syncActivityDraft',save({payload:payload('')}));
  assert.equal(first.version,1);
  assert.deepEqual(await call('syncActivityDraft',save({payload:payload('')})),first);
  await assert.rejects(call('syncActivityDraft',save({payload:payload('Changed')})), {code:'already-exists'});
  assert.equal((await call('getActivityDrafts',{})).drafts.length,1);
  assert.equal((await call('getActivityDrafts',{},'bob')).drafts.length,0);
  await assert.rejects(call('getActivityDrafts',{owner:'alice'},'bob'), {code:'invalid-argument'});
});

test('stale device cannot overwrite, deletion is durable and cannot be resurrected', async () => {
  await call('syncActivityDraft',save());
  await assert.rejects(call('syncActivityDraft',save({operationId:'stale'})), {code:'aborted'});
  const deleted = await call('syncActivityDraft',save({operationId:'delete',expectedVersion:1,state:'deleted',payload:null}));
  assert.equal(deleted.state,'deleted');
  const fetched = (await call('getActivityDrafts',{})).drafts[0];
  assert.equal(fetched.state,'deleted');
  assert.equal(fetched.payload,null);
  for (const receipt of (await db.collection('privateDraftOwners/alice/drafts/draft/operations').get()).docs) {
    assert.equal(receipt.data().result.payload,undefined);
  }
  await assert.rejects(call('syncActivityDraft',save({operationId:'revive',expectedVersion:2})), {code:'failed-precondition'});
});

test('published state requires an actual acknowledged activity owned by caller', async () => {
  await call('syncActivityDraft',save());
  const close = save({operationId:'publish',expectedVersion:1,state:'published',payload:null,requestId:'publication'});
  await assert.rejects(call('syncActivityDraft',close), {code:'failed-precondition'});
  await db.doc('activityCommands/alice/requests/publication').set({receipt:{activityId:'activity'}});
  await db.doc('activities/activity').set({createdBy:'bob',category:'social'});
  await assert.rejects(call('syncActivityDraft',close), {code:'permission-denied'});
  await db.doc('activities/activity').set({createdBy:'alice',category:'social'});
  await assert.rejects(call('syncActivityDraft',save({operationId:'late-edit',expectedVersion:1,
    payload:{...payload('Late edit'),requestId:'publication'}})),{code:'failed-precondition'});
  const result = await call('syncActivityDraft',close);
  assert.equal(result.category,'social'); assert.equal(result.state,'published');
  assert.deepEqual(await call('syncActivityDraft',close),result);
  await assert.rejects(call('syncActivityDraft',{...close,id:'other-draft',expectedVersion:0,operationId:'other'}),{code:'already-exists'});
});

test('paginated list retains more than fifty plans and rejects oversized fields', async () => {
  await assert.rejects(call('syncActivityDraft',save({payload:payload('x'.repeat(121))})), {code:'invalid-argument'});
  for(let i=0;i<55;i++) await db.doc(`privateDraftOwners/alice/drafts/id${String(i).padStart(3,'0')}`)
    .set({version:1,state:'active',category:'study',payload:payload(),updatedAt:new Date().toISOString()});
  const first = await call('getActivityDrafts',{});
  assert.equal(first.drafts.length,50);
  const second = await call('getActivityDrafts',{cursor:first.nextCursor});
  assert.equal(second.drafts.length,5); assert.equal(second.nextCursor,null);
});
