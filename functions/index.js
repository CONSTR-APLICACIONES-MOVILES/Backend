const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onDocumentCreated, onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineString} = require("firebase-functions/params");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const {BigQuery} = require("@google-cloud/bigquery");

const {joinDemoGroups} = require("./src/groupMembership");
const {loadQuery, buildRecommendationInsight, buildReminderTimingInsight} = require("./src/insights");
const {refreshTeamInsights} = require('./src/teamInsights');
const {refreshResponseTimeInsight} = require('./src/responseTimeInsights');
const {refreshCoordinationInsight, recordFirstConfirmation} = require('./src/coordinationInsights');
const {ActivityRepository} = require("./src/activityRepository");
const {ActivityService} = require("./src/activityService");
const {createActivityCallables} = require("./src/activityCallables");
const {dispatchPendingReminders} = require("./src/reminderService");
const {requireOrganizationAnalytics} = require('./src/organizationAccess');

initializeApp();

// bq6 reads the analytics export in bigquery, the dataset name comes from functions/.env
const analyticsDataset = defineString("ANALYTICS_DATASET");

const activityRepository = new ActivityRepository(getFirestore());
const activityService = new ActivityService(activityRepository);
Object.assign(exports, createActivityCallables(activityService));
const {MobileService} = require("./src/mobileService");
const {createMobileCallables} = require("./src/mobileCallables");
Object.assign(exports, createMobileCallables(new MobileService(getFirestore())));

// Extends the same Firestore insights collection without replacing the team's
// deployed BQ1/7/8/9 aggregator or its historical metric definitions.
exports.refreshActivityInsights = onCall({region:'us-central1'}, async request => {
  requireOrganizationAnalytics(request);
  if (Object.keys(request.data || {}).length) throw new HttpsError('invalid-argument','No arguments accepted.');
  return require('./src/activityInsights').refreshActivityInsights(getFirestore());
});

/* BQ3 feedback loop: use server records, including displayed but unselected slots.
 * The shared service/repository instance is the analytics facade for both clients.
 */
exports.refreshSlotRecommendation = onSchedule(
    {schedule: "every day 04:00", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const result = await require('./src/activityInsights').refreshActivityInsights(getFirestore());
      logger.info('BQ2/BQ3/BQ13 insights updated', result);
    });

exports.refreshResponseTimeInsight = onSchedule(
    {schedule: "every day 04:15", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const insight = await refreshResponseTimeInsight(getFirestore());
      logger.info("BQ5 insight updated", {
        group_sizes: insight.by_group_size.length,
        invitations: insight.invitations,
        completed: insight.completed,
      });
    });

exports.refreshReminderTimingInsight = onSchedule(
    {schedule: "every day 04:30", timeZone: "America/Bogota", region: "us-central1"},
    async () => {
      const projectId = process.env.GCLOUD_PROJECT;
      const query = loadQuery("bq6_reminder_response_timing.sql", projectId, analyticsDataset.value());
      const [rows] = await new BigQuery().query({query});
      const insight = buildReminderTimingInsight(rows);
      await getFirestore().doc("insights/bq6_reminder_timing").set({
        ...insight,
        updated_at: FieldValue.serverTimestamp(),
      });
      logger.info("BQ6 reminder timing insight updated", {
        recommended_delay_minutes: insight.recommended_delay_minutes,
        recommendation_ready: insight.recommendation_ready,
        sample_size: insight.sample_size,
      });
    });
exports.refreshTeamInsightsNightly = onSchedule(
    {schedule:'every day 04:30', timeZone:'America/Bogota', region:'us-central1'},
    async () => refreshTeamInsights(getFirestore()));

exports.refreshTeamInsights = onCall({region:'us-central1'}, async request => {
  requireOrganizationAnalytics(request);
  return refreshTeamInsights(getFirestore());
});

exports.refreshCoordinationInsight = onSchedule(
    {schedule:'every day 04:45', timeZone:'America/Bogota', region:'us-central1'},
    async () => refreshCoordinationInsight(getFirestore()));

exports.recordFirstActivityConfirmation = onDocumentWritten(
    {document:'activities/{activityId}', region:'us-central1'},
    async event => recordFirstConfirmation(getFirestore(), event.params.activityId,
      event.data?.before.data(), event.data?.after.data(), event.data?.after.updateTime?.toDate()));

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
      const result = await dispatchPendingReminders(getFirestore());
      logger.info('Pending reminders dispatched', result);
    });

// Legacy samples are local-only. Real signups must not acquire memberships.
exports.joinDemoGroupsOnSignUp = functionsV1.auth.user().onCreate(async (user) => {
  const db = getFirestore();
  const joined = await joinDemoGroups(db, user);
  if (joined) logger.info("Local account joined sample groups", {uid: user.uid});
});


// Firestore source also covers compatible Java edits. Deterministic event IDs
// make repeated trigger delivery safe without manufacturing push delivery.
exports.activityChangesToInbox = onDocumentWritten(
    {document: 'activities/{activityId}', region: 'us-central1'}, async event => {
      const {recordActivityChange} = require('./src/alertEvents');
      await recordActivityChange(getFirestore(), event.params.activityId,
        event.data?.before.data(), event.data?.after.data(), event.data?.after.updateTime?.toString(), event.data?.after.updateTime?.toDate());
    });
