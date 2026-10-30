const {documentId, requireThat} = require('./errors');
const {versionOf} = require('./activityLifecycle');

class ActivityParticipants {
  constructor(db, {clock = () => new Date()} = {}) { this.db = db; this.clock = clock; }

  async context(reader, uid, activityId) {
    requireThat(uid, 'unauthenticated', 'Sign in to continue.');
    documentId(activityId, 'activityId');
    const ref = this.db.doc(`activities/${activityId}`);
    const read = ref => reader === this.db ? ref.get() : reader.get(ref);
    const doc = await read(ref), activity = doc.data();
    requireThat(activity, 'not-found', 'Activity not found.');
    const group = (await read(this.db.doc(`groups/${activity.groupId}`))).data();
    requireThat(group?.memberIds.includes(uid), 'permission-denied', 'Join the group before joining this activity.');
    const ids = (activity.participantIds || group.memberIds).filter(id => group.memberIds.includes(id));
    return {ref, doc, activity, group, ids};
  }

  async getActivityParticipants(uid, input) {
    const {doc, activity, group, ids} = await this.context(this.db, uid, input.activityId);
    const organizer = activity.createdBy === uid;
    const responses = ids.length ? await this.db.getAll(...ids.map(id => this.db.doc(`inboxes/${id}/items/${input.activityId}`))) : [];
    return {activityId: input.activityId, groupId: activity.groupId, version: versionOf(doc),
      canManage: organizer, cancelled: !!activity.cancelled, joined: ids.includes(uid),
      canInviteFriends: group.ownerId === uid,
      canJoin: !activity.cancelled && !ids.includes(uid),
      members: group.memberIds.filter(id => organizer || ids.includes(id)).map(id => ({
        id, name: (group.members || []).find(m => m.id === id)?.name || 'Group member',
        organizer: id === activity.createdBy, invited: ids.includes(id),
        response: id === activity.createdBy ? 'accepted' : responses[ids.indexOf(id)]?.data()?.response || null,
      }))};
  }

  async inviteGroupFriend(uid, input) {
    requireThat(uid, 'unauthenticated', 'Sign in to continue.');
    documentId(input.groupId, 'groupId'); documentId(input.userId, 'userId');
    requireThat(input.userId !== uid, 'invalid-argument', 'You are already in this group.');
    return this.db.runTransaction(async tx => {
      const ref = this.db.doc(`groups/${input.groupId}`);
      const group = (await tx.get(ref)).data();
      requireThat(group?.ownerId === uid && group.memberIds.includes(uid), 'permission-denied', 'Only the group owner can invite friends.');
      const relation = (await tx.get(this.db.doc(`friendships/${require('./socialService').pair(uid,input.userId)}`))).data();
      requireThat(relation?.state === 'accepted', 'permission-denied', 'Invite an accepted friend.');
      const person = (await tx.get(this.db.doc(`publicPeople/${input.userId}`))).data();
      const invitationRef = this.db.doc(`groupInvitations/${input.userId}/items/${input.groupId}`);
      const previous = (await tx.get(invitationRef)).data();
      if(group.memberIds.includes(input.userId) || previous?.state === 'pending' && previous.expiresAt.toDate() > this.clock()) return {sent:true};
      const invitedIds = [...new Set([...(group.invitedIds || []),input.userId])];
      requireThat(invitedIds.length <= 100,'resource-exhausted','This group has reached its invitation limit.');
      tx.update(ref,{invitedIds});
      tx.set(invitationRef,{groupId:input.groupId,groupName:group.name,inviteeName:person?.name || 'ParchApp user',
        inviterId:uid,state:'pending',expiresAt:new Date(+this.clock()+7*86400000)});
      return {sent:true};
    });
  }

  async changeActivityParticipants(uid, input) {
    requireThat(['join', 'invite', 'remove'].includes(input.action), 'invalid-argument', 'Choose join, invite or remove.');
    const target = input.action === 'join' ? uid : input.userId;
    documentId(target, 'userId');
    return this.db.runTransaction(async tx => {
      const {ref, doc, activity, group, ids} = await this.context(tx, uid, input.activityId);
      requireThat(!activity.cancelled, 'failed-precondition', 'This activity is cancelled.');
      requireThat(input.action === 'join' || activity.createdBy === uid, 'permission-denied', 'Only the organizer can manage participants.');
      requireThat(group.memberIds.includes(target), 'permission-denied', 'Invite this person to the group first.');
      requireThat(input.action !== 'remove' || target !== activity.createdBy, 'failed-precondition', 'The organizer must remain in the activity.');
      const inbox = this.db.doc(`inboxes/${target}/items/${input.activityId}`);
      const response = (await tx.get(inbox)).data();
      // An identical retry must not reset a participant's response.
      if (input.action === 'remove' && !ids.includes(target) || input.action === 'invite' && ids.includes(target) ||
          input.action === 'join' && ids.includes(target) && (target === activity.createdBy || response?.response === 'accepted')) {
        return {saved: true, activityId: input.activityId};
      }
      requireThat(typeof input.expectedVersion === 'string' && versionOf(doc) === input.expectedVersion,
        'aborted', 'Participants changed. Reload before trying again.');
      const now = this.clock();
      const next = input.action === 'remove' ? ids.filter(id => id !== target) : [...new Set([...ids, target])];
      requireThat(next.length <= 100, 'resource-exhausted', 'This activity has reached its participant limit.');
      tx.update(ref, {participantIds: next.sort(), updatedAt: now});
      if (input.action === 'remove') {
        tx.delete(inbox);
      } else {
        tx.set(inbox, {activityId: input.activityId, groupId: activity.groupId,
          invitedAt: response?.invitedAt || now, response: input.action === 'join' ? 'accepted' : null,
          ...(input.action === 'join' ? {respondedAt: response?.respondedAt || now, lastResponseAt:now,
            firstResponse:response?.firstResponse || response?.response || 'accepted'} : {}),
          availabilityAtInvitation: 'UNKNOWN', isRead: input.action === 'join'}, {merge: true});
        if (input.action === 'join') {
          const invitedAt = response?.invitedAt?.toDate ? response.invitedAt.toDate() : now;
          tx.set(inbox, {responseMs: response?.responseMs ?? Math.max(0, now - invitedAt)}, {merge:true});
          tx.set(this.db.doc(`activities/${input.activityId}/lifecycle/response-${uid}`), {
            type:'RESPONSE_RECEIVED',activityId:input.activityId,actorId:uid,response:'accepted',createdAt:response?.respondedAt || now,updatedAt:now,
          }, {merge:true});
        }
      }
      return {saved: true, activityId: input.activityId};
    });
  }
}
module.exports = {ActivityParticipants};
