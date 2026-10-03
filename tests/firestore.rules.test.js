// Runs against the Firestore emulator: npm run test:rules
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {initializeTestEnvironment, assertSucceeds, assertFails} = require("@firebase/rules-unit-testing");
const {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
  arrayUnion, arrayRemove, serverTimestamp,
} = require("firebase/firestore");
const {demoGroups} = require("../functions/src/demoData");

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-parchapp",
    firestore: {rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8")},
  });
});

test.after(async () => {
  await env.cleanup();
});

test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [id, data] of Object.entries(demoGroups())) {
      await setDoc(doc(db, "groups", id), data);
    }
    await setDoc(doc(db, "activities", "a1"), {
      groupId: "roomies", title: "Dinner", category: "social", date: "", time: "8:00 PM",
      location: "", status: "PROPOSED", createdBy: "mateo", createdAt: new Date(),
    });
    await setDoc(doc(db, "insights", "bq3_slot_acceptance"), {recommended_position: 1});
  });
});

// "alex" is a member of every demo group; "stranger" of none.
const as = (uid) => env.authenticatedContext(uid).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

// Same fields FirestoreActivityRepository writes.
function newActivity(uid, groupId = "roomies") {
  return {
    groupId, title: "House dinner", category: "other", date: "", time: "7:30 PM – 11:00 PM",
    location: "", status: "PROPOSED", createdBy: uid, createdAt: serverTimestamp(),
  };
}

test("members read their group; others and signed-out users cannot", async () => {
  await assertSucceeds(getDoc(doc(as("alex"), "groups/roomies")));
  await assertFails(getDoc(doc(as("stranger"), "groups/roomies")));
  await assertFails(getDoc(doc(anonymous(), "groups/roomies")));
});

test("a member can RSVP for themselves, as the Android app does", async () => {
  const ref = doc(as("alex"), "groups/intramurals");
  await assertSucceeds(updateDoc(ref, {goingIds: arrayUnion("alex"), maybeIds: arrayRemove("alex")}));
  await assertSucceeds(updateDoc(ref, {goingIds: arrayRemove("alex"), maybeIds: arrayUnion("alex")}));
});

test("a member cannot RSVP for someone else", async () => {
  const ref = doc(as("alex"), "groups/intramurals");
  await assertFails(updateDoc(ref, {goingIds: arrayRemove("intramurals_m1")}));
  await assertFails(updateDoc(ref, {maybeIds: arrayUnion("intramurals_m4")}));
});

test("a member can add and remove pending invitations", async () => {
  const ref = doc(as("alex"), "groups/roomies");
  await assertSucceeds(updateDoc(ref, {pendingInvites: arrayUnion("maria@uni.edu")}));
  await assertSucceeds(updateDoc(ref, {pendingInvites: arrayRemove("maria@uni.edu")}));
  await assertFails(updateDoc(doc(as("stranger"), "groups/roomies"), {pendingInvites: arrayUnion("x@uni.edu")}));
});

test("clients cannot change members, rename, create or delete groups", async () => {
  const db = as("alex");
  await assertFails(updateDoc(doc(db, "groups/roomies"), {memberIds: arrayUnion("stranger")}));
  await assertFails(updateDoc(doc(db, "groups/roomies"), {name: "Hacked"}));
  await assertFails(setDoc(doc(db, "groups/new"), demoGroups().roomies));
  await assertFails(deleteDoc(doc(db, "groups/roomies")));
});

test("a member can create an activity in their group", async () => {
  await assertSucceeds(setDoc(doc(as("alex"), "activities/new1"), newActivity("alex")));
});

test("activity creation checks group, author, timestamp and fields", async () => {
  await assertFails(setDoc(doc(as("stranger"), "activities/x"), newActivity("stranger")));
  await assertFails(setDoc(doc(as("alex"), "activities/x"), newActivity("mateo")));
  await assertFails(setDoc(doc(as("alex"), "activities/x"), {...newActivity("alex"), createdAt: new Date(0)}));
  await assertFails(setDoc(doc(as("alex"), "activities/x"), {...newActivity("alex"), status: "DONE"}));
  await assertFails(setDoc(doc(as("alex"), "activities/x"), {...newActivity("alex"), title: ""}));
  await assertFails(setDoc(doc(as("alex"), "activities/x"), {...newActivity("alex"), extra: true}));
});

test("activities are readable by group members through a groupId query", async () => {
  const byGroup = (db) => query(collection(db, "activities"), where("groupId", "==", "roomies"));
  await assertSucceeds(getDocs(byGroup(as("alex"))));
  await assertSucceeds(getDoc(doc(as("alex"), "activities/a1")));
  await assertFails(getDocs(byGroup(as("stranger"))));
  await assertFails(getDocs(collection(as("alex"), "activities")));
});

test("only the organiser confirms or deletes an activity", async () => {
  await assertFails(updateDoc(doc(as("alex"), "activities/a1"), {status: "CONFIRMED"}));
  await assertSucceeds(updateDoc(doc(as("mateo"), "activities/a1"), {status: "CONFIRMED"}));
  await assertFails(updateDoc(doc(as("mateo"), "activities/a1"), {groupId: "eng"}));
  await assertFails(deleteDoc(doc(as("alex"), "activities/a1")));
  await assertSucceeds(deleteDoc(doc(as("mateo"), "activities/a1")));
});

test("insights are read-only for signed-in users", async () => {
  await assertSucceeds(getDoc(doc(as("stranger"), "insights/bq3_slot_acceptance")));
  await assertFails(getDoc(doc(anonymous(), "insights/bq3_slot_acceptance")));
  await assertFails(setDoc(doc(as("alex"), "insights/bq3_slot_acceptance"), {recommended_position: 3}));
});

test("seeded groups match the fields the apps read", async () => {
  const snapshot = await getDoc(doc(as("alex"), "groups/roomies"));
  const data = snapshot.data();
  for (const key of ["name", "icon", "planTitle", "members", "goingIds", "maybeIds", "pendingInvites"]) {
    assert.ok(key in data, `missing ${key}`);
  }
});

test("optional descriptions are bounded and can be edited by the organizer", async () => {
  const ref = doc(as("alex"), "activities/described");
  await assertSucceeds(setDoc(ref, {...newActivity("alex"), description: "Bring notes"}));
  await assertSucceeds(updateDoc(ref, {description: "Bring your book"}));
  await assertFails(updateDoc(ref, {description: 42}));
  await assertFails(updateDoc(ref, {description: "x".repeat(5001)}));
  await assertFails(updateDoc(doc(as("mateo"), "activities/described"), {description: "Someone else's activity"}));
});

test("canonical schedules and recommendation analytics cannot be forged by clients", async () => {
  await assertFails(setDoc(doc(as("alex"), "activities/scheduled"), {
    ...newActivity("alex"), startTime: new Date(), endTime: new Date(), durationMinutes: 60,
  }));
  const ref = doc(as("mateo"), "activities/a1");
  await assertFails(updateDoc(ref, {durationMinutes: 60}));
  await env.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), "activities/a1"), {
      startTime: new Date("2026-10-02T15:00:00Z"), endTime: new Date("2026-10-02T16:00:00Z"), durationMinutes: 60,
    });
    await setDoc(doc(context.firestore(), "slotRecommendations/r1"), {activityId: "a1", outcome: null});
  });
  await assertFails(updateDoc(ref, {time: "11:00"}));
  await assertFails(updateDoc(ref, {date: "tomorrow"}));
  await assertSucceeds(updateDoc(ref, {description: "Schedule stays consistent", status: "CONFIRMED"}));
  const analytics = doc(as("mateo"), "slotRecommendations/r1");
  await assertFails(getDoc(analytics));
  await assertFails(updateDoc(analytics, {outcome: "ACCEPTED_UNCHANGED"}));
  await assertFails(setDoc(doc(as("mateo"), "slotRecommendations/fake"), {presentedAt: serverTimestamp()}));
  await assertFails(deleteDoc(analytics));
});
