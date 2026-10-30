const {FieldValue} = require('firebase-admin/firestore');

/** Delivers due in-app reminders once and stores the analytics fields clients need for BQ6. */
async function dispatchPendingReminders(db, {clock = () => new Date()} = {}) {
  const now = clock();
  const pending = await db.collectionGroup('reminders')
      .where('status', '==', 'SCHEDULED')
      .where('scheduledAt', '<=', now)
      .limit(500)
      .get();
  let dispatched = 0;
  let cancelled = 0;

  for (const reminderSnapshot of pending.docs) {
    const result = await db.runTransaction(async tx => {
      const latest = (await tx.get(reminderSnapshot.ref)).data();
      if (!latest || latest.status !== 'SCHEDULED') return 'skipped';
      const parts = reminderSnapshot.ref.path.split('/');
      if (parts.length !== 6 || parts[0] !== 'inboxes' || parts[2] !== 'items' || parts[4] !== 'reminders') {
        tx.update(reminderSnapshot.ref, {status: 'CANCELLED', cancelledAt: now});
        return 'cancelled';
      }
      const uid = parts[1];
      const activityId = parts[3];
      const inboxRef = db.doc(`inboxes/${uid}/items/${activityId}`);
      const activityRef = db.doc(`activities/${activityId}`);
      const [inboxSnapshot, activitySnapshot] = await Promise.all([tx.get(inboxRef), tx.get(activityRef)]);
      const inbox = inboxSnapshot.data();
      const activity = activitySnapshot.data();
      if (!activity || activity.cancelled) {
        tx.update(reminderSnapshot.ref, {status: 'CANCELLED', cancelledAt: now});
        return 'cancelled';
      }
      const activityStart = activity.startTime?.toDate ? activity.startTime.toDate() :
        activity.startTime ? new Date(activity.startTime) : null;
      if (activityStart && activityStart <= now) {
        tx.update(reminderSnapshot.ref, {status: 'CANCELLED', cancelledAt: now});
        return 'cancelled';
      }
      const isOrganizerReminder = latest.purpose === 'activity' && activity.createdBy === uid;
      if ((!inbox && !isOrganizerReminder) ||
          (inbox?.response && (inbox.response === 'declined' || !isOrganizerReminder))) {
        tx.update(reminderSnapshot.ref, {status: 'CANCELLED', cancelledAt: now});
        return 'cancelled';
      }

      const sequence = latest.sequence || 1;
      const eventId = `reminder-${activityId}-${sequence}`;
      tx.set(db.doc(`alertEvents/${uid}/items/${eventId}`), {
        activityId,
        groupId: activity.groupId,
        kind: 'reminder',
        title: isOrganizerReminder ? `Upcoming activity: ${activity.title}` : `Pending response: ${activity.title}`,
        description: [activity.date, activity.time, activity.location].filter(Boolean).join(' · '),
        createdAt: now,
        sentAt: now,
        reminderId: eventId,
        purpose: latest.purpose || 'rsvp',
        strategy: latest.strategy,
        sequence,
        delayMinutes: latest.delayMinutes ?? latest.minutesBefore ?? null,
      }, {merge: true});
      tx.update(reminderSnapshot.ref, {status: 'SENT', sentAt: now});
      tx.set(inboxRef, {
        reminderCount: FieldValue.increment(1),
        lastReminderAt: now,
        lastReminderStrategy: latest.strategy,
      }, {merge: true});
      return 'sent';
    });
    if (result === 'sent') dispatched++;
    else if (result === 'cancelled') cancelled++;
  }

  return {checked: pending.size, dispatched, cancelled};
}

module.exports = {dispatchPendingReminders};
