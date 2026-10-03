const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");

const {demoGroups, memberForAccount} = require("./src/demoData");
const {buildRecommendationInsight} = require("./src/insights");
const {ActivityRepository} = require("./src/activityRepository");
const {ActivityService} = require("./src/activityService");
const {createActivityCallables} = require("./src/activityCallables");

initializeApp();

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
