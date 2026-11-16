const test = require("node:test");
const assert = require("node:assert/strict");
const {createRequire} = require("node:module");
const req = createRequire(require.resolve("../functions/package.json"));
const {initializeApp, deleteApp} = req("firebase-admin/app");
const {getFirestore} = req("firebase-admin/firestore");
const {MobileService} = require("../functions/src/mobileService");
const {createMobileCallables} = require("../functions/src/mobileCallables");
const {ActivityRepository} = require("../functions/src/activityRepository");
const {ActivityService} = require("../functions/src/activityService");
const {joinDemoGroups} = require("../functions/src/groupMembership");

let app, db, api, now;
const call = (name, data = {}, uid = "member") => api[name].run({data, auth: uid ? {uid} : undefined});
const sync = (data = {}, uid = "member") => call("importCalendarAvailability", {
  startDate: "2026-10-19", days: 3, intervals: [], ...data,
}, uid);

test.before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  app = initializeApp({projectId: "demo-parchapp"}, "mobile-api-tests");
  db = getFirestore(app);
  api = createMobileCallables(new MobileService(db, {clock: () => now,
    userLookup: async (uid) => ({email: `${uid}@test.example`, emailVerified: false})}));
});
test.beforeEach(async () => {
  now = new Date("2026-10-19T13:00:00Z");
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-parchapp/databases/(default)/documents`, {method: "DELETE"});
  await db.doc("groups/g1").set({name: "Shared", memberIds: ["organizer", "member"],
    members: ["organizer", "member"].map((id) => ({id, name: id, busy: [{start: 600, end: 660}]})),
    goingIds: [], maybeIds: [], pendingInvites: []});
  await db.doc("activities/a1").set({groupId: "g1", createdBy: "organizer", title: "Real activity",
    description: "Bring notes", location: "Library", date: "", time: "", status: "PROPOSED", category: "study", createdAt: now});
});
test.after(async () => { await db?.terminate(); if (app) await deleteApp(app); });

test("mobile endpoints require auth and reject impersonation and unsupported fields", async () => {
  for (const name of ["getProfile", "getAlerts", "getScheduleFriends"]) {
    await assert.rejects(call(name, {}, null), {code: "unauthenticated"});
    await assert.rejects(call(name, {uid: "someone"}), {code: "invalid-argument"});
  }
  await assert.rejects(call('respondToActivityInvitation', {
    id: 'a1', response: 'accepted', clientUserId: 'someone-else',
  }), {code: 'permission-denied'});
});
test("friends are shared members only; outsiders cannot query private availability", async () => {
  assert.deepEqual((await call("getScheduleFriends")).friends.map((f) => f.id), ["organizer"]);
  await assert.rejects(call("getScheduleDay", {date: "2026-10-19", friendIds: ["outsider"]}), {code: "permission-denied"});
  const result = await call("getScheduleDay", {date: "2026-10-19", friendIds: ["organizer"]});
  assert.equal(result.schedules.length, 2);
  assert.deepEqual(result.schedules[0].busy, [{start: 600, end: 660}]);
  assert.equal(result.schedules[0].title, undefined);
});

test("Home activity discovery returns membership-scoped serializable summaries", async () => {
  const result = await call('getActivities');
  assert.equal(result.activities[0].id, 'a1');
  assert.equal(result.activities[0].title, 'Real activity');
  assert.deepEqual((await call('getActivities', {}, 'outsider')).activities, []);
  await assert.rejects(call('getActivities', {}, null), {code: 'unauthenticated'});
});
test("legacy today's blocks are not treated as future availability", async () => {
  const result = await call("getScheduleDay", {date: "2026-10-20", friendIds: ["organizer"]});
  assert.ok(result.schedules.every((s) => !s.known));
  await assert.rejects(call("getScheduleDay", {date: "2026-02-30", friendIds: []}), {code: "invalid-argument"});
});
test("calendar import splits midnight, merges overlaps and stores explicit empty days", async () => {
  await sync({intervals: [
    {start: "2026-10-19T23:30:00-05:00", end: "2026-10-20T01:00:00-05:00"},
    {start: "2026-10-20T00:30:00-05:00", end: "2026-10-20T02:00:00-05:00"},
  ]});
  const a = (await db.doc("availability/member/days/2026-10-19").get()).data();
  const b = (await db.doc("availability/member/days/2026-10-20").get()).data();
  const c = (await db.doc("availability/member/days/2026-10-21").get()).data();
  assert.deepEqual(a.busy, [{start: 1410, end: 1440}]);
  assert.deepEqual(b.busy, [{start: 0, end: 120}]);
  assert.deepEqual(c.busy, []);
  assert.deepEqual(Object.keys(a).sort(), ["busy", "date", "source", "updatedAt"]);
  const group = (await db.doc("groups/g1").get()).data();
  assert.deepEqual(group.members[0].busy, [{start: 600, end: 660}]);
  assert.deepEqual(group.members[1].busy, a.busy);
  assert.equal(group.members[1].calendarSync, true);
});
test("invalid or private calendar payloads are rejected without erasing the previous import", async () => {
  await sync();
  const before = (await db.doc("availability/member/days/2026-10-19").get()).data();
  for (const interval of [
    {start: "2026-10-19T12:00:00Z", end: "2026-10-19T13:00:00Z", title: "Private"},
    {start: "invalid", end: "invalid"},
    {start: "2026-10-19T13:00:00Z", end: "2026-10-19T12:00:00Z"},
  ]) await assert.rejects(sync({intervals: [interval]}), {code: "invalid-argument"});
  assert.deepEqual((await db.doc("availability/member/days/2026-10-19").get()).data(), before);
});
test("resync replaces removed events and future day snapshots feed the recommendation engine", async () => {
  await sync({intervals: [{start: "2026-10-20T05:00:00Z", end: "2026-10-21T05:00:00Z"}]});
  now = new Date("2026-10-20T13:00:00Z");
  const activities = new ActivityService(new ActivityRepository(db), {clock: () => now});
  const result = await activities.getActivityRecommendations("organizer", {activityId: "a1", durationMinutes: 60});
  assert.equal(result.recommendations.length, 0);
  await sync({startDate: "2026-10-20", intervals: []});
  assert.equal((await db.doc("availability/member/days/2026-10-20").get()).data().busy.length, 0);
  assert.ok((await activities.getActivityRecommendations("organizer", {activityId: "a1", durationMinutes: 60})).recommendations.length > 0);
});
test("missing imported day cannot silently fall back to stale legacy busy blocks", async () => {
  await sync();
  await db.doc("availability/member/days/2026-10-19").delete();
  const result = await call("getScheduleDay", {date: "2026-10-19", friendIds: []});
  assert.equal(result.schedules[0].known, false);
  const activities = new ActivityService(new ActivityRepository(db), {clock: () => now});
  await assert.rejects(activities.getActivityRecommendations("organizer", {activityId: "a1", durationMinutes: 60}), {code: "failed-precondition"});
});
test("profile persists owned fields and derives identity and counters without fake statistics", async () => {
  const before = await call("getProfile");
  assert.equal(before.name, "member@test.example");
  assert.equal(before.verified, false);
  assert.equal(before.activeGroups, 1);
  assert.equal(before.onTimeRate, null);
  await call("updateProfile", {fields: {name: "Student", program: "Engineering", status: "busy", semester: 4}});
  const after = await call("getProfile");
  assert.equal(after.name, "Student");
  assert.equal(after.status, "busy");
  assert.equal((await call("getScheduleFriends", {}, "organizer")).friends[0].name, "Student");
  assert.equal((await call("getProfile", {}, "organizer")).name, "organizer@test.example");
});
test("clients cannot forge verification, counters or arbitrary photo paths", async () => {
  for (const fields of [{verified: true}, {plansCompleted: 100}, {id: "organizer"},
    {semester: -1}, {status: "anything"}, {photoData: "C:/private/photo.jpg"}]) {
    await assert.rejects(call("updateProfile", {fields}), {code: "invalid-argument"});
  }
});
test("inbox uses real activities and read state persists for the caller only", async () => {
  const inbox = await call("getAlerts");
  assert.equal(inbox.alerts[0].id, "a1");
  assert.equal(inbox.alerts[0].groupSize, 2);
  assert.deepEqual((await call("getAlerts", {}, "organizer")).alerts, []);
  assert.deepEqual((await call("getAlerts", {}, "outsider")).alerts, []);
  await call("markAlertsRead", {ids: ["a1"]});
  assert.equal((await call("getAlerts")).alerts[0].isRead, true);
  await assert.rejects(call("markAlertsRead", {ids: ["a1"]}, "outsider"), {code: "permission-denied"});
});
test("per-activity responses persist, are idempotent and appear in activity details", async () => {
  await call("respondToActivityInvitation", {id: "a1", response: "accepted"});
  await call("respondToActivityInvitation", {id: "a1", response: "accepted"});
  assert.equal((await call("getAlerts")).alerts[0].response, "accepted");
  const service = new ActivityService(new ActivityRepository(db), {clock: () => now});
  const details = await service.getActivity("organizer", {activityId: "a1"});
  assert.equal(details.participants.find((p) => p.id === "member").activityRsvpStatus, "accepted");
  assert.deepEqual((await db.doc("groups/g1").get()).data().goingIds, []);
  await call("respondToActivityInvitation", {id: "a1", response: "declined", expectedResponse:"accepted"});
  assert.equal((await call("getAlerts")).alerts[0].response,"declined");
});
test("organizer reminder choice is stored and scheduled relative to the activity", async () => {
  const startTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  await db.doc("activities/a1").update({startTime, endTime: new Date(startTime.getTime() + 60 * 60 * 1000)});
  const receipt = await call("setActivityReminder", {activityId: "a1", minutesBefore: 30}, "organizer");
  assert.equal(receipt.enabled, true);
  assert.equal(receipt.minutesBefore, 30);
  assert.equal(Date.parse(receipt.scheduledAt), startTime.getTime() - 30 * 60 * 1000);
  const reminder = (await db.doc("inboxes/organizer/items/a1/reminders/activity-reminder").get()).data();
  assert.equal(reminder.purpose, "activity");
  assert.equal(reminder.status, "SCHEDULED");
  assert.equal((await db.doc("activities/a1").get()).data().reminderMinutesBefore, 30);
  assert.deepEqual(await call("setActivityReminder", {activityId: "a1", minutesBefore: 0}, "organizer"),
    {activityId: "a1", minutesBefore: 0, enabled: false});
  assert.equal((await db.doc("inboxes/organizer/items/a1/reminders/activity-reminder").get()).data().status, "CANCELLED");
});
test("reminder configuration enforces participant, valid option and future scheduled activity", async () => {
  await assert.rejects(call("setActivityReminder", {activityId: "a1", minutesBefore: 15}, "outsider"),
    {code: "permission-denied"});
  await assert.rejects(call("setActivityReminder", {activityId: "a1", minutesBefore: 20}, "organizer"),
    {code: "invalid-argument"});
  await assert.rejects(call("setActivityReminder", {activityId: "a1", minutesBefore: 15}, "organizer"),
    {code: "failed-precondition"});
});
test("outsiders, authors and forged responses cannot mutate another invitation", async () => {
  for (const uid of ["outsider", "organizer"]) await assert.rejects(
      call("respondToActivityInvitation", {id: "a1", response: "accepted"}, uid), {code: "permission-denied"});
  await assert.rejects(call("respondToActivityInvitation", {id: "a1", response: "onMyWay"}), {code: "invalid-argument"});
  assert.equal((await db.doc("inboxes/member/items/a1").get()).exists, false);
});
test("concurrent conflicting invitation responses commit exactly one choice", async () => {
  const result = await Promise.allSettled(["accepted", "declined"].map((response) =>
    call("respondToActivityInvitation", {id: "a1", response})));
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(["accepted", "declined"].includes((await call("getAlerts")).alerts[0].response));
});

test("signup creates missing demo groups and repeated concurrent delivery never duplicates members", async () => {
  const user = {uid: "newcomer", email: "new.user@example.test"};
  await Promise.all([joinDemoGroups(db, user, {emulator:true}), joinDemoGroups(db, user, {emulator:true})]);
  const groups = await db.collection("groups").where("memberIds", "array-contains", user.uid).get();
  assert.equal(groups.size, 5);
  for (const group of groups.docs) {
    assert.equal(group.data().memberIds.filter((id) => id === user.uid).length, 1);
    assert.equal(group.data().members.filter((m) => m.id === user.uid).length, 1);
  }
});
