const {canShare} = require('./communityService');
/** Firestore access stays here; services receive this repository by injection. */
class ActivityRepository {
  constructor(db) {
    this.db = db;
  }

  async withActivity(activityId, work, {date, viewer} = {}) {
    const activityRef = this.db.collection("activities").doc(activityId);
    return this.db.runTransaction(async (transaction) => {
      const activityDoc = await transaction.get(activityRef);
      const activity = activityDoc.data();
      let group = activity ? (await transaction.get(
          this.db.collection("groups").doc(activity.groupId))).data() : undefined;
      if (activity?.participantIds && group?.members) group = {...group, members: group.members.filter(m => activity.participantIds.includes(m.id))};
      if (date && group?.members) {
        const synced = group.members.filter((m) => m.calendarSync);
        const snapshots = synced.length ? await transaction.getAll(...synced.map((m) =>
          this.db.doc(`availability/${m.id}/days/${date}`))) : [];
        const busy = new Map(synced.map((m, i) => [m.id, snapshots[i].data()?.busy]));
        group = {...group, members: group.members.map((m) => m.calendarSync ?
          {...m, busy: busy.get(m.id)} : m)};
      }
      if (viewer && group?.members) {
        const members = [];
        for (const member of group.members) members.push(await canShare(this.db, member.id, viewer, 'scheduleVisibility', transaction) ? member : {...member, busy: undefined});
        group = {...group, members};
      }
      const responseDocs = group?.members?.length ? await transaction.getAll(...group.members.map((m) =>
        this.db.doc(`inboxes/${m.id}/items/${activityId}`))) : [];
      const activityResponses = Object.fromEntries((group?.members || []).map((m, i) =>
        [m.id, responseDocs[i].data()?.response || null]));
      const recommendations = this.db.collection("slotRecommendations");
      return work({
        activity, group, activityResponses,
        version: activity ? `${activityDoc.updateTime.seconds}:${activityDoc.updateTime.nanoseconds}` : null,
        getRecommendations: async (ids) => {
          const docs = await transaction.getAll(...ids.map((id) => recommendations.doc(id)));
          return docs.map((doc) => doc.exists ? {id: doc.id, ...doc.data()} : null);
        },
        getBatch: async (batchId) => {
          const snapshot = await transaction.get(recommendations.where("batchId", "==", batchId));
          return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
        },
        listRecommendations: async () => {
          const snapshot = await transaction.get(recommendations.where("activityId", "==", activityId));
          return snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
        },
        putRecommendation: (id, data) => transaction.set(recommendations.doc(id), data),
        updateRecommendation: (id, data) => transaction.update(recommendations.doc(id), data),
        updateActivity: (data) => transaction.update(activityRef, data),
      });
    });
  }

  async presentedSince(since, until) {
    const snapshot = await this.db.collection("slotRecommendations")
        .where("presentedAt", ">=", since).where("presentedAt", "<=", until).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}

module.exports = {ActivityRepository};
