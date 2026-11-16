const {createHash} = require('node:crypto');
const {requireThat, documentId} = require('./errors');
const statuses = ['active', 'busy', 'inClass', 'focused', 'inTransit', 'offline'];
const scopes = ['groups', 'closeFriends', 'private'];
const iso = v => v ? (v.toDate ? v.toDate() : new Date(v)).toISOString() : null;
const defaults = {statusVisibility: 'groups', scheduleVisibility: 'groups', closeFriendIds: [], invitationBadges: true};
async function canShare(db, owner, viewer, field, tx) {
  if (owner === viewer) return true;
  const ref = db.doc(`profiles/${owner}`);
  const data = (await (tx ? tx.get(ref) : ref.get())).data() || {};
  const scope = data.preferences?.[field] || 'groups';
  return scope === 'groups' || scope === 'closeFriends' && (data.preferences?.closeFriendIds || []).includes(viewer);
}
function effectiveStatus(data, now) {
  return data.statusExpiresAt && Date.parse(iso(data.statusExpiresAt)) <= now.getTime() ? 'offline' : data.status || 'active';
}
class CommunityService {
  constructor(db, {clock = () => new Date(), userLookup} = {}) { this.db = db; this.clock = clock; this.userLookup = userLookup; }
  async peers(uid) {
    const docs = await this.db.collection('groups').where('memberIds', 'array-contains', uid).get();
    return new Map(docs.docs.flatMap(d => (d.data().members || []).filter(m => m.id !== uid && d.data().memberIds.includes(m.id)).map(m => [m.id, {id: m.id, name: m.name || m.id}])));
  }
  async getCommunityPeers(uid) { return {peers: [...(await this.peers(uid)).values()]}; }
  async createGroup(uid, input) {
    documentId(input.requestId, 'requestId');
    requireThat(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.trim().length <= 80, 'invalid-argument', 'Use a group name between 2 and 80 characters.');
    requireThat(['study', 'social', 'sports', 'living'].includes(input.category), 'invalid-argument', 'Choose a group category.');
    requireThat(Array.isArray(input.inviteeIds) && input.inviteeIds.length <= 30 && new Set(input.inviteeIds).size === input.inviteeIds.length && !input.inviteeIds.includes(uid), 'invalid-argument', 'Choose up to 30 distinct peers.');
    input.inviteeIds.forEach(id => documentId(id, 'inviteeId'));
    const name = input.name.trim(), ids = [...input.inviteeIds].sort();
    const fingerprint = JSON.stringify([name, input.category, ids]);
    const id = `community-${createHash('sha256').update(`${uid}:${input.requestId}`).digest('hex').slice(0, 32)}`;
    const user = await this.userLookup(uid);
    const receipt = {groupId: id, invitationCount: ids.length};
    return this.db.runTransaction(async tx => {
      const ref = this.db.doc(`groupCommands/${uid}/requests/${input.requestId}`);
      const previous = (await tx.get(ref)).data();
      if (previous) { requireThat(previous.fingerprint === fingerprint, 'already-exists', 'This creation key has different details.'); return previous.receipt; }
      const groups = (await tx.get(this.db.collection('groups').where('memberIds', 'array-contains', uid))).docs;
      requireThat(ids.every(peer => groups.some(g => g.data().memberIds.includes(peer))), 'permission-denied', 'Invite members of your shared groups only.');
      const profile = (await tx.get(this.db.doc(`profiles/${uid}`))).data();
      const member = {id: uid, name: profile?.name || user.displayName || user.email || uid, initials: ''};
      tx.create(this.db.doc(`groups/${id}`), {name, icon: '👥', planTitle: '', category: input.category, ownerId: uid, invitedIds: ids, createdAt: this.clock(), memberIds: [uid], members: [member], goingIds: [], maybeIds: [], pendingInvites: []});
      for (const peer of ids) tx.create(this.db.doc(`groupInvitations/${peer}/items/${id}`), {groupId: id, groupName: name, inviteeName: groups.flatMap(g => g.data().members || []).find(m => m.id === peer)?.name || peer, inviterId: uid, state: 'pending', expiresAt: new Date(this.clock().getTime() + 7 * 86400000)});
      tx.create(ref, {fingerprint, receipt}); return receipt;
    });
  }
  async getGroupInvitations(uid) {
    const docs = await this.db.collection(`groupInvitations/${uid}/items`).orderBy('expiresAt', 'desc').limit(100).get();
    return {invitations: docs.docs.map(d => ({...d.data(), expiresAt: iso(d.data().expiresAt), state: d.data().state === 'pending' && d.data().expiresAt.toDate() <= this.clock() ? 'expired' : d.data().state}))};
  }
  async respondGroupInvitation(uid, input) {
    documentId(input.groupId, 'groupId');
    requireThat(['accepted', 'declined'].includes(input.response), 'invalid-argument', 'Choose accept or decline.');
    const user = await this.userLookup(uid);
    return this.db.runTransaction(async tx => {
      const ref = this.db.doc(`groupInvitations/${uid}/items/${input.groupId}`);
      const invitation = (await tx.get(ref)).data();
      requireThat(invitation, 'permission-denied', 'This invitation is not yours.');
      if (invitation.state === input.response) return {groupId: input.groupId, state: invitation.state};
      requireThat(invitation.state === 'pending' && invitation.expiresAt.toDate() > this.clock(), 'failed-precondition', 'Invitation expired or resolved.');
      const groupRef = this.db.doc(`groups/${input.groupId}`), group = (await tx.get(groupRef)).data();
      const profile = (await tx.get(this.db.doc(`profiles/${uid}`))).data();
      requireThat(group, 'not-found', 'Group unavailable.');
      if (input.response === 'accepted' && !group.memberIds.includes(uid)) {
        requireThat(group.memberIds.length < 100, 'resource-exhausted', 'Group is full.');
        tx.update(groupRef, {memberIds: [...group.memberIds, uid], members: [...group.members, {id: uid, name: profile?.name || user.displayName || user.email || uid, initials: ''}]});
      }
      tx.update(ref, {state: input.response, respondedAt: this.clock()}); return {groupId: input.groupId, state: input.response};
    });
  }
  async revokeGroupInvitation(uid, input) {
    documentId(input.groupId, 'groupId'); documentId(input.inviteeId, 'inviteeId');
    await this.db.runTransaction(async tx => {
      const group = (await tx.get(this.db.doc(`groups/${input.groupId}`))).data();
      requireThat(group?.ownerId === uid, 'permission-denied', 'Only the owner can revoke invitations.');
      const ref = this.db.doc(`groupInvitations/${input.inviteeId}/items/${input.groupId}`), invite = (await tx.get(ref)).data();
      requireThat(invite && ['pending', 'revoked'].includes(invite.state), 'failed-precondition', 'Invitation already resolved.');
      tx.update(ref, {state: 'revoked'});
    }); return {revoked: true};
  }
  async getGroupDetails(uid, input) {
    documentId(input.groupId, 'groupId');
    const group = (await this.db.doc(`groups/${input.groupId}`).get()).data();
    requireThat(group?.memberIds.includes(uid), 'permission-denied', 'Group membership is required.');
    const members = await Promise.all(group.memberIds.map(async id => {
      const data = (await this.db.doc(`profiles/${id}`).get()).data() || {};
      const shared = await canShare(this.db, id, uid, 'statusVisibility');
      return {id, name: group.members.find(m => m.id === id)?.name || id,
        status: shared ? effectiveStatus(data, this.clock()) : null,
        statusExpiresAt: shared ? iso(data.statusExpiresAt) : null};
    }));
    const invitations = group.ownerId === uid ? await Promise.all((group.invitedIds || []).map(async id => {
      const data = (await this.db.doc(`groupInvitations/${id}/items/${input.groupId}`).get()).data();
      return {inviteeId: id, name: data?.inviteeName || id, state: data?.state === 'pending' && data.expiresAt.toDate() <= this.clock() ? 'expired' : data?.state || 'unavailable'};
    })) : [];
    const page = await this.db.collection('activities').where('groupId', '==', input.groupId).orderBy('createdAt', 'desc').limit(100).get();
    const activities = await Promise.all(page.docs.map(async doc => {
      const a = doc.data(), ids = (a.participantIds || group.memberIds).filter(id => group.memberIds.includes(id));
      const responses = ids.length ? await this.db.getAll(...ids.map(id => this.db.doc(`inboxes/${id}/items/${doc.id}`))) : [];
      const attendance = {accepted: 0, maybe: 0, declined: 0, pending: 0};
      ids.forEach((id, i) => { attendance[id === a.createdBy ? 'accepted' : responses[i].data()?.response || 'pending']++; });
      return {id: doc.id, title: a.title, status: a.status, cancelled: !!a.cancelled, startTime: iso(a.startTime), endTime: iso(a.endTime), location: a.location || '', date: a.date || '', time: a.time || '', attendance};
    }));
    return {activities, invitations, id: input.groupId, name: group.name, category: group.category || 'group', ownerId: group.ownerId || null, members};
  }
  async updatePresence(uid, input) {
    requireThat(statuses.includes(input.status) && scopes.includes(input.visibility), 'invalid-argument', 'Choose a status and visibility.');
    const expiry = new Date(input.expiresAt);
    requireThat(typeof input.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(input.expiresAt) && Number.isFinite(expiry.getTime()) && expiry > this.clock() && expiry - this.clock() <= 24 * 3600000, 'invalid-argument', 'Status must expire within the next 24 hours.');
    await this.db.doc(`profiles/${uid}`).set({status: input.status, statusExpiresAt: expiry, preferences: {statusVisibility: input.visibility}}, {merge: true});
    return {saved: true};
  }
  async updatePreferences(uid, input) {
    const p = input.preferences;
    requireThat(p && Object.keys(p).every(k => Object.keys(defaults).includes(k)) && scopes.includes(p.statusVisibility) && scopes.includes(p.scheduleVisibility) && typeof p.invitationBadges === 'boolean' && Array.isArray(p.closeFriendIds) && p.closeFriendIds.length <= 100 && new Set(p.closeFriendIds).size === p.closeFriendIds.length, 'invalid-argument', 'Invalid preferences.');
    const peers = await this.peers(uid);
    requireThat(p.closeFriendIds.every(id => peers.has(id)), 'permission-denied', 'Close friends must share a group with you.');
    await this.db.runTransaction(async tx => {
      const groups = p.scheduleVisibility === 'groups' ? [] : (await tx.get(this.db.collection('groups').where('memberIds', 'array-contains', uid))).docs;
      requireThat(groups.length < 450, 'resource-exhausted', 'Too many groups for one privacy update.');
      tx.set(this.db.doc(`profiles/${uid}`), {preferences: p}, {merge: true});
      // Legacy group documents are readable by all members. Remove their undated
      // blocks when sharing narrows; dated availability stays server-only.
      for (const group of groups) tx.update(group.ref, {members: group.data().members.map(m => {
        if (m.id !== uid) return m;
        const {busy, busyDate, ...identity} = m;
        return {...identity, calendarSync: true};
      })});
    }); return {saved: true};
  }
}
module.exports = {CommunityService, canShare, effectiveStatus, defaults};
