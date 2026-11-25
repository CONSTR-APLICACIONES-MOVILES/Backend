const crypto = require('node:crypto');
const {requireThat, documentId, integer} = require('./errors');

const CATEGORIES = ['study', 'sports', 'social', 'other'];
const PAYLOAD_KEYS = ['groupId','title','description','category','location','status','date','time',
  'measurementVersion','requestId','locationDetails','startsAt','endsAt','planning','comparison'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
function validatePayload(payload, category) {
  requireThat(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).every(k => PAYLOAD_KEYS.includes(k)), 'invalid-argument', 'Invalid draft fields.');
  requireThat(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 65536,
    'invalid-argument', 'Draft exceeds 64 KiB.');
  for (const [key, max] of Object.entries({groupId:128,title:120,description:5000,location:500,date:100,time:100})) {
    requireThat(typeof payload[key] === 'string' && payload[key].length <= max,
      'invalid-argument', `Invalid draft ${key}.`);
  }
  requireThat(payload.category === category && ['PROPOSED','CONFIRMED'].includes(payload.status),
    'invalid-argument', 'Invalid draft category or status.');
  if (payload.requestId != null) documentId(payload.requestId, 'requestId');
  for (const key of ['startsAt','endsAt']) requireThat(payload[key] == null ||
    (typeof payload[key] === 'string' && Number.isFinite(Date.parse(payload[key]))),
  'invalid-argument', `Invalid ${key}.`);
  // Drafts may be incomplete. Schedule/group authorization happens on publish.
  return payload;
}

class ActivityDrafts {
  constructor(db, {clock = () => new Date()} = {}) { this.db = db; this.clock = clock; }
  collection(uid) { documentId(uid, 'uid'); return this.db.collection(`privateDraftOwners/${uid}/drafts`); }
  async getActivityDrafts(uid, input = {}) {
    let query = this.collection(uid).orderBy('__name__').limit(50);
    if (input.cursor != null) query = query.startAfter(documentId(input.cursor, 'cursor'));
    const page = await query.get();
    return {drafts:page.docs.map(d => ({id:d.id,...d.data()})),
      nextCursor:page.size === 50 ? page.docs[page.docs.length - 1].id : null};
  }
  async syncActivityDraft(uid, input) {
    const id = documentId(input.id, 'id');
    const operationId = documentId(input.operationId, 'operationId');
    integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER, 'expectedVersion');
    requireThat(['active','deleted','published'].includes(input.state) && CATEGORIES.includes(input.category),
      'invalid-argument', 'Invalid draft state or category.');
    if (input.state === 'active') validatePayload(input.payload, input.category);
    else requireThat(input.payload == null, 'invalid-argument', 'Closed drafts must omit their details.');
    if (input.state === 'published') documentId(input.requestId, 'requestId');
    const ref = this.collection(uid).doc(id);
    const receiptRef = ref.collection('operations').doc(operationId);
    const {clientUserId, ...command} = input;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex');
    return this.db.runTransaction(async tx => {
      const receipt = (await tx.get(receiptRef)).data();
      if (receipt) {
        requireThat(receipt.fingerprint === fingerprint, 'already-exists', 'Operation changed.');
        return receipt.result;
      }
      const current = (await tx.get(ref)).data();
      requireThat((current?.version || 0) === input.expectedVersion,
        'aborted', 'Draft changed on another device. Resolve the conflict.');
      requireThat(!current || current.state === 'active' || input.state === current.state,
        'failed-precondition', 'This draft is closed. Save a new draft to continue.');
      let category = input.category;
      let activityId = null;
      let publicationRef;
      if (input.state === 'active' && input.payload.requestId) {
        const published = (await tx.get(this.db.doc(`activityCommands/${uid}/requests/${input.payload.requestId}`))).data();
        requireThat(!published, 'failed-precondition', 'This draft was already published. Save a new draft to continue.');
      }
      if (input.state === 'published') {
        const command = (await tx.get(this.db.doc(`activityCommands/${uid}/requests/${input.requestId}`))).data();
        requireThat(command?.receipt?.activityId, 'failed-precondition', 'Publish the activity before closing its draft.');
        const activity = (await tx.get(this.db.doc(`activities/${command.receipt.activityId}`))).data();
        requireThat(activity?.createdBy === uid, 'permission-denied', 'Activity ownership is required.');
        publicationRef = this.db.doc(`privateDraftOwners/${uid}/publications/${input.requestId}`);
        const bound = (await tx.get(publicationRef)).data();
        requireThat(!bound || bound.draftId === id, 'already-exists', 'This activity already closed another draft.');
        category = activity.category;
        activityId = command.receipt.activityId;
      }
      const record = {version:input.expectedVersion + 1, state:input.state, category,
        payload:input.state === 'active' ? input.payload : null,
        requestId:input.requestId || input.payload?.requestId || null,
        activityId, updatedAt:this.clock().toISOString()};
      // Receipts retain idempotence metadata, never historical draft text.
      const {payload:details, ...metadata} = record;
      const result = {id,...metadata};
      tx.set(ref, record);
      if (publicationRef) tx.set(publicationRef, {draftId:id,activityId});
      tx.create(receiptRef, {fingerprint,result});
      return result;
    });
  }
}
module.exports = {ActivityDrafts, validatePayload};
