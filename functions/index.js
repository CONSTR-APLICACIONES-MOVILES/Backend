const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {defineString} = require("firebase-functions/params");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const {BigQuery} = require("@google-cloud/bigquery");

const {demoGroups, memberForAccount} = require("./src/demoData");
const {loadQuery, buildRecommendationInsight, buildResponseTimeInsight} = require("./src/insights");
const {ActivityRepository} = require("./src/activityRepository");
const {ActivityService} = require("./src/activityService");
const {createActivityCallables} = require("./src/activityCallables");

initializeApp();

const analyticsDataset = defineString("ANALYTICS_DATASET");

const activityRepository = new ActivityRepository(getFirestore());
const activityService = new ActivityService(activityRepository);
Object.assign(exports, createActivityCallables(activityService));

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

/* Adds every new account to the demo groups, so a real user can RSVP, compare availability and create activities right after signing up. Remove when the apps can create and join groups.
 */
exports.joinDemoGroupsOnSignUp = functionsV1.auth.user().onCreate(async (user) => {
  const db = getFirestore();
  const newMember = memberForAccount(user.uid, user.email, user.displayName);
  const batch = db.batch();
  for (const groupId of Object.keys(demoGroups())) {
    batch.update(db.collection("groups").doc(groupId), {
      members: FieldValue.arrayUnion(newMember),
      memberIds: FieldValue.arrayUnion(user.uid),
    });
  }
  await batch.commit();
  logger.info("New account joined the demo groups", {uid: user.uid});
});
