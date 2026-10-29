const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated, onDocumentWritten} = require("firebase-functions/v2/firestore");
const {defineString} = require("firebase-functions/params");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const {BigQuery} = require("@google-cloud/bigquery");

const {joinDemoGroups} = require("./src/groupMembership");
const {loadQuery, buildRecommendationInsight, buildResponseTimeInsight} = require("./src/insights");
const {refreshTeamInsights} = require("./src/teamInsights");
const {ActivityRepository} = require("./src/activityRepository");
const {ActivityService} = require("./src/activityService");
const {createActivityCallables} = require("./src/activityCallables");

initializeApp();

const analyticsDataset = defineString("ANALYTICS_DATASET");

const activityRepository = new ActivityRepository(getFirestore());
const activityService = new ActivityService(activityRepository);
Object.assign(exports, createActivityCallables(activityService));
const {MobileService} = require("./src/mobileService");
const {createMobileCallables} = require("./src/mobileCallables");
Object.assign(exports, createMobileCallables(new MobileService(getFirestore())));

/* BQ3 feedback loop: use server records, including displayed but unselected slots.
 * The shared service/repository instance is the analytics facade for both clients.
 */
exports.refreshSlotRecommendation = onSchedule(
    {schedule: "every day 04:00", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const until = new Date();
      const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
      const insight = buildRecommendationInsight(await activityRepository.presentedSince(since, until));
      await getFirestore().doc("insights/bq3_slot_acceptance").set({
        ...insight,
        window_start: since,
        window_end: until,
        updated_at: FieldValue.serverTimestamp(),
      });
      logger.info("BQ3 insight updated", {
        recommended_position: insight.recommended_position,
        sample_size: insight.sample_size,
      });
    });

exports.refreshResponseTimeInsight = onSchedule(
    {schedule: "every day 04:15", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const projectId = process.env.GCLOUD_PROJECT;
      const query = loadQuery("bq5_response_time.sql", projectId, analyticsDataset.value());
      const [rows] = await new BigQuery().query({query});

      const insight = buildResponseTimeInsight(rows);
      await getFirestore().doc("insights/bq5_response_time").set({
        ...insight,
        updated_at: FieldValue.serverTimestamp(),
      });
      logger.info("BQ5 insight updated", {
        group_sizes: insight.by_group_size.length,
        invitations: insight.invitations,
        completed: insight.completed,
      });
    });

// team dashboard: bq1, bq7, bq8 and bq9 from the analyticsEvents the app writes, every night
exports.refreshTeamInsightsNightly = onSchedule(
    {schedule: "every day 04:30", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const summary = await refreshTeamInsights(getFirestore(), {serverTime: FieldValue.serverTimestamp()});
      logger.info("Team insights updated", summary);
    });

// the refresh button of the dashboard calls this, only a signed in user can do it
exports.refreshTeamInsights = onCall({region: "us-central1"}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const summary = await refreshTeamInsights(getFirestore(), {serverTime: FieldValue.serverTimestamp()});
  logger.info("Team insights updated from the dashboard", summary);
  return summary;
});

exports.resetRsvpOnNewActivity = onDocumentCreated(
    {document: "activities/{activityId}", region: "us-central1"},
    async (event) => {
      const groupId = event.data && event.data.get("groupId");
      if (!groupId) {
        return;
      }
      await getFirestore().doc(`groups/${groupId}`).update({goingIds: [], maybeIds: []});
      logger.info("RSVPs reset for a new activity", {groupId, activityId: event.params.activityId});
    });

/* In-app reminder delivery. This deliberately records delivery state even when push delivery is
 * unavailable; the mobile inbox can render the alert on its next refresh. */
exports.dispatchPendingReminders = onSchedule(
    {schedule: "every 5 minutes", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const db = getFirestore();
      const now = new Date();
      const pending = await db.collectionGroup("reminders")
          .where("status", "==", "SCHEDULED")
          .where("scheduledAt", "<=", now).limit(500).get();
      const batch = db.batch();
      let dispatched = 0;
      for (const reminder of pending.docs) {
        const parts = reminder.ref.path.split("/");
        const uid = parts[1];
        const activityId = parts[3];
        const inboxRef = db.doc(`inboxes/${uid}/items/${activityId}`);
        const inbox = (await inboxRef.get()).data();
        const activity = (await db.doc(`activities/${activityId}`).get()).data();
        if (!activity || activity.cancelled) {
          batch.update(reminder.ref, {status: "CANCELLED", cancelledAt: now});
          continue;
        }
        const data = reminder.data();
        const isOrganizerReminder = data.purpose === "activity" && activity.createdBy === uid;
        if ((!inbox && !isOrganizerReminder) ||
            (inbox?.response && (inbox.response === "declined" || !isOrganizerReminder))) {
          batch.update(reminder.ref, {status: "CANCELLED", cancelledAt: now});
          continue;
        }
        const eventId = `reminder-${activityId}-${data.sequence || 1}`;
        batch.set(db.doc(`alertEvents/${uid}/items/${eventId}`), {
          activityId, groupId: activity.groupId, kind: "reminder",
          title: isOrganizerReminder ? `Upcoming activity: ${activity.title}` : `Pending response: ${activity.title}`,
          description: [activity.date, activity.time, activity.location].filter(Boolean).join(" · "),
          createdAt: now, strategy: data.strategy, sequence: data.sequence || 1,
        }, {merge: true});
        batch.update(reminder.ref, {status: "SENT", sentAt: now});
        batch.set(inboxRef, {reminderCount: FieldValue.increment(1), lastReminderAt: now,
          lastReminderStrategy: data.strategy}, {merge: true});
        dispatched++;
      }
      if (!pending.empty) await batch.commit();
      logger.info("Pending reminders dispatched", {checked: pending.size, dispatched});
    });

/* Adds every new account to the demo groups, so a real user can RSVP, compare availability and create activities right after signing up. Remove when the apps can create and join groups.
 */
exports.joinDemoGroupsOnSignUp = functionsV1.auth.user().onCreate(async (user) => {
  const db = getFirestore();
  await joinDemoGroups(db, user);
  logger.info("New account joined the demo groups", {uid: user.uid});
});


// Firestore source also covers compatible Java edits. Deterministic event IDs
// make repeated trigger delivery safe without manufacturing push delivery.
exports.activityChangesToInbox = onDocumentWritten(
    {document: 'activities/{activityId}', region: 'us-central1'}, async event => {
      const {recordActivityChange} = require('./src/alertEvents');
      await recordActivityChange(getFirestore(), event.params.activityId,
        event.data?.before.data(), event.data?.after.data(), event.data?.after.updateTime?.toString(), event.data?.after.updateTime?.toDate());
    });
