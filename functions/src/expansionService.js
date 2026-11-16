const {createHash, randomBytes} = require('node:crypto');
const {requireThat, documentId, integer} = require('./errors');
const {versionOf} = require('./activityLifecycle');
const digest = v => createHash('sha256').update(v).digest('hex');
const iso = v => v ? (v.toDate ? v.toDate() : new Date(v)).toISOString() : null;
function text(value, max, label) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 'invalid-argument', `Invalid ${label}.`);
  return value.trim();
}
async function activityContext(db, uid, id, tx) {
  documentId(id, 'activityId');
  const read = ref => tx ? tx.get(ref) : ref.get();
  const activity = (await read(db.doc(`activities/${id}`))).data();
  requireThat(activity, 'not-found', 'Activity not found.');
  const group = (await read(db.doc(`groups/${activity.groupId}`))).data();
  requireThat(group?.memberIds.includes(uid), 'permission-denied', 'Group membership is required.');
  return {activity, group};
}
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r/g, ''); }
// Fold at 75 UTF-8 octets without splitting a Unicode character (RFC 5545).
function fold(line) {
  const lines = []; let current = '';
  for (const character of line) {
    if (Buffer.byteLength(current + character) > 75) { lines.push(current); current = ' '; }
    current += character;
  }
  return [...lines, current].join('\r\n');
}
class ExpansionService {
  constructor(db, {clock = () => new Date(), userLookup} = {}) { this.db = db; this.clock = clock; this.userLookup = userLookup; }
  async discover(uid, input) {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    requireThat(typeof input.query === 'string' && query.length <= 100 && ['all','groups','activities','people'].includes(input.kind) && ['all','study','social','sports','living','other'].includes(input.category || 'all'), 'invalid-argument', 'Invalid search filters.');
    const limit = integer(input.limit ?? 20, 1, 30, 'limit');
    const scope = digest(JSON.stringify([uid, query, input.kind, input.category || 'all']));
    let after = '';
    if (input.cursor) {
      let cursor; try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch (_) {}
      requireThat(cursor?.scope === scope && typeof cursor.after === 'string', 'invalid-argument', 'Search changed. Restart the search.'); after = cursor.after;
    }
    const groups = (await this.db.collection('groups').where('memberIds', 'array-contains', uid).get()).docs;
    const rows = [], peers = new Map();
    for (const doc of groups) {
      const g = doc.data();
      rows.push({id: doc.id, kind: 'groups', title: g.name, category: g.category || 'other', description: `${g.memberIds.length} members`, targetId: doc.id});
      for (const m of g.members || []) if (m.id !== uid && g.memberIds.includes(m.id)) peers.set(m.id, {id: m.id, kind: 'people', title: m.name || m.id, category: 'other', description: 'Shared group member', targetId: m.id});
    }
    if (['all','activities'].includes(input.kind)) {
      const pages = await Promise.all(groups.map(g => this.db.collection('activities').where('groupId','==',g.id).orderBy('createdAt','desc').limit(100).get()));
      for (const page of pages) for (const doc of page.docs) {
        const a = doc.data(); if (a.cancelled) continue;
        rows.push({id: doc.id, kind: 'activities', title: a.title, category: a.category || 'other', description: [a.date, a.time, a.location].filter(Boolean).join(' · '), targetId: doc.id});
      }
    }
    rows.push(...peers.values());
    const results = rows.filter(r => (input.kind === 'all' || r.kind === input.kind) && (!input.category || input.category === 'all' || r.category === input.category) && `${r.title} ${r.description}`.toLowerCase().includes(query))
        .map(r => ({...r, key: `${r.title.toLowerCase()}|${r.kind}|${r.id}`})).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).filter(r => r.key > after);
    const page = results.slice(0, limit);
    return {results: page, cursor: results.length > limit ? Buffer.from(JSON.stringify({scope, after: page.at(-1).key})).toString('base64url') : null, scope: 'Your groups, shared peers and latest 100 activities per group'};
  }
  async getSharedProfile(uid, input) {
    documentId(input.userId, 'userId');
    const groups = (await this.db.collection('groups').where('memberIds','array-contains',uid).get()).docs;
    const member = groups.flatMap(g => g.data().members || []).find(m => m.id === input.userId && groups.some(g => g.data().memberIds.includes(m.id)));
    requireThat(member || input.userId === uid, 'permission-denied', 'This profile is outside your shared groups.');
    const profile = (await this.db.doc(`profiles/${input.userId}`).get()).data() || {};
    return {id: input.userId, name: member?.name || profile.name || uid};
  }
  async getActivityMaterials(uid, input) {
    const {activity} = await activityContext(this.db, uid, input.activityId);
    const [saved, checks] = await Promise.all([this.db.doc(`activityMaterials/${input.activityId}`).get(), this.db.doc(`activityMaterials/${input.activityId}/checks/${uid}`).get()]);
    return {activityId: input.activityId, version: saved.exists ? versionOf(saved) : 'none', canEdit: activity.createdBy === uid && !activity.cancelled, cancelled: !!activity.cancelled,
      topics: (saved.data()?.topics || []).map(t => ({...t, completed: checks.data()?.[t.id] === true})), resources: saved.data()?.resources || []};
  }
  async saveActivityMaterials(uid, input) {
    requireThat(Array.isArray(input.topics) && input.topics.length <= 30 && Array.isArray(input.resources) && input.resources.length <= 20, 'invalid-argument', 'Use up to 30 topics and 20 HTTPS resources.');
    const topics = input.topics.map(t => { documentId(t.id, 'topicId'); return {id: t.id, title: text(t.title,120,'topic')}; });
    const resources = input.resources.map(r => {
      documentId(r.id,'resourceId'); const title = text(r.title,120,'resource title'), url = text(r.url,2048,'resource URL');
      let parsed; try { parsed = new URL(url); } catch (_) {}
      requireThat(parsed?.protocol === 'https:' && !parsed.username && !parsed.password, 'invalid-argument', 'Resources must be HTTPS links without credentials.');
      return {id: r.id, title, url: parsed.toString()};
    });
    requireThat(new Set(topics.map(t=>t.id)).size === topics.length && new Set(resources.map(r=>r.id)).size === resources.length, 'invalid-argument', 'Duplicate material IDs.');
    const fingerprint = digest(JSON.stringify({topics, resources}));
    await this.db.runTransaction(async tx => {
      const {activity} = await activityContext(this.db,uid,input.activityId,tx);
      requireThat(activity.createdBy === uid && !activity.cancelled, 'permission-denied', 'Only the active organizer can edit resources.');
      const ref = this.db.doc(`activityMaterials/${input.activityId}`), saved = await tx.get(ref);
      if (saved.data()?.fingerprint === fingerprint) return;
      requireThat(input.expectedVersion === (saved.exists ? versionOf(saved) : 'none'), 'aborted', 'Resources changed. Reload before editing.');
      tx.set(ref, {topics, resources, fingerprint, updatedAt: this.clock(), updatedBy: uid});
    });
    return this.getActivityMaterials(uid,input);
  }
  async setTopicCompletion(uid, input) {
    documentId(input.topicId,'topicId'); requireThat(typeof input.completed === 'boolean','invalid-argument','Supply the desired checklist state.');
    await this.db.runTransaction(async tx => {
      const {activity} = await activityContext(this.db,uid,input.activityId,tx);
      requireThat(!activity.cancelled,'failed-precondition','Activity cancelled.');
      const material = (await tx.get(this.db.doc(`activityMaterials/${input.activityId}`))).data();
      requireThat(material?.topics.some(t => t.id === input.topicId),'not-found','Topic was removed. Reload.');
      tx.set(this.db.doc(`activityMaterials/${input.activityId}/checks/${uid}`), {[input.topicId]:input.completed},{merge:true});
    }); return {saved:true, completed:input.completed};
  }
  async createShareLink(uid,input) {
    documentId(input.entityId,'entityId'); documentId(input.requestId,'requestId');
    requireThat(['group','activity','profile'].includes(input.kind),'invalid-argument','Invalid share entity.');
    const hours = integer(input.hours ?? 24,1,168,'hours'), signature = JSON.stringify([input.kind,input.entityId,hours]);
    const token = randomBytes(32).toString('base64url'), linkId = digest(token);
    return this.db.runTransaction(async tx => {
      const command = this.db.doc(`shareCommands/${uid}/requests/${input.requestId}`), prior = (await tx.get(command)).data();
      if (prior) { requireThat(prior.signature === signature,'already-exists','Share request has different details.'); return prior.receipt; }
      if (input.kind === 'group') {
        const group = (await tx.get(this.db.doc(`groups/${input.entityId}`))).data();
        requireThat(group?.ownerId === uid && group.memberIds.includes(uid),'permission-denied','Only the group owner creates enrollment links.');
      } else if (input.kind === 'activity') await activityContext(this.db,uid,input.entityId,tx);
      else requireThat(input.entityId === uid,'permission-denied','Share your own profile only.');
      const expiresAt = new Date(this.clock().getTime()+hours*3600000);
      const receipt = {token, linkId, kind:input.kind, entityId:input.entityId, expiresAt:expiresAt.toISOString()};
      tx.create(this.db.doc(`shareLinks/${linkId}`), {kind:input.kind, entityId:input.entityId, ownerId:uid, expiresAt, revoked:false, uses:0});
      tx.create(command,{signature,receipt}); return receipt;
    });
  }
  async readLink(uid, token, tx) {
    requireThat(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token),'invalid-argument','Invalid invitation code.');
    const ref = this.db.doc(`shareLinks/${digest(token)}`), saved = await (tx ? tx.get(ref) : ref.get()), link = saved.data();
    requireThat(link && !link.revoked && link.expiresAt.toDate() > this.clock(),'failed-precondition','Link expired, revoked or unavailable.');
    return {ref, link};
  }
  async resolveShareLink(uid,input) {
    const {link} = await this.readLink(uid,input.token);
    let title, member = false;
    if (link.kind === 'group') {
      const group = (await this.db.doc(`groups/${link.entityId}`).get()).data();
      requireThat(group && group.ownerId === link.ownerId,'not-found','Group unavailable.');
      title = group.name; member = group.memberIds.includes(uid);
    } else if (link.kind === 'activity') title = (await activityContext(this.db,uid,link.entityId)).activity.title;
    else {
      const publicPerson=(await this.db.doc(`publicPeople/${link.entityId}`).get()).data();
      title=publicPerson?.name || (await this.getSharedProfile(uid,{userId:link.entityId})).name;
    }
    return {kind:link.kind, entityId:link.entityId, title, member, expiresAt:iso(link.expiresAt)};
  }
  async joinSharedGroup(uid,input) {
    const user = await this.userLookup(uid);
    return this.db.runTransaction(async tx => {
      const {ref,link} = await this.readLink(uid,input.token,tx);
      requireThat(link.kind === 'group','invalid-argument','This is not an enrollment link.');
      const groupRef = this.db.doc(`groups/${link.entityId}`), group = (await tx.get(groupRef)).data();
      const profile = (await tx.get(this.db.doc(`profiles/${uid}`))).data();
      const inviteRef = this.db.doc(`groupInvitations/${uid}/items/${link.entityId}`);
      const invitation = (await tx.get(inviteRef)).data();
      requireThat(group && group.ownerId === link.ownerId,'not-found','Group unavailable.');
      if (!group.memberIds.includes(uid)) {
        requireThat(group.memberIds.length < 100 && link.uses < 100,'resource-exhausted','Group or enrollment link is full.');
        tx.update(groupRef,{memberIds:[...group.memberIds,uid],members:[...group.members,{id:uid,name:profile?.name || user.displayName || user.email || uid,initials:''}]});
        tx.update(ref,{uses:link.uses+1});
      }
      if(invitation?.state === 'pending') tx.update(inviteRef,{state:'accepted',respondedAt:this.clock(),source:'link'});
      return {groupId:link.entityId, joined:true};
    });
  }
  async getShareLinks(uid,input) {
    documentId(input.entityId,'entityId');
    const docs = await this.db.collection('shareLinks').where('ownerId','==',uid).where('entityId','==',input.entityId).get();
    return {links:docs.docs.map(d => ({linkId:d.id,kind:d.data().kind,expiresAt:iso(d.data().expiresAt),state:d.data().revoked?'revoked':d.data().expiresAt.toDate()<=this.clock()?'expired':'active'}))};
  }
  async revokeShareLink(uid,input) {
    documentId(input.linkId,'linkId');
    await this.db.runTransaction(async tx => {
      const ref=this.db.doc(`shareLinks/${input.linkId}`), link=(await tx.get(ref)).data();
      requireThat(link?.ownerId===uid,'permission-denied','Only the link owner can revoke it.'); tx.update(ref,{revoked:true});
    }); return {revoked:true};
  }
  async exportActivityCalendar(uid,input) {
    const {activity:a}=await activityContext(this.db,uid,input.activityId);
    requireThat(a.startTime && a.endTime && !a.cancelled,'failed-precondition','Only a scheduled active activity can be exported.');
    const stamp=v=>iso(v).replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ParchApp//Activities//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${input.activityId}@parchapp`, `DTSTAMP:${stamp(this.clock())}`,`DTSTART:${stamp(a.startTime)}`,`DTEND:${stamp(a.endTime)}`,`SUMMARY:${icsEscape(a.title)}`,`DESCRIPTION:${icsEscape(a.description)}`,`LOCATION:${icsEscape(a.location)}`,'END:VEVENT','END:VCALENDAR'];
    return {fileName:`parchapp-${input.activityId}.ics`,content:lines.map(fold).join('\r\n')+'\r\n',mimeType:'text/calendar',activityId:input.activityId};
  }
  async getCalendarImportStatus(uid) {
    const data=(await this.db.doc(`calendarImports/${uid}`).get()).data();
    return {lastImportedAt:iso(data?.lastImportedAt),startDate:data?.startDate || null,days:data?.days || 0,source:data?.source || null,automatic:false};
  }
}
module.exports={ExpansionService,activityContext};
