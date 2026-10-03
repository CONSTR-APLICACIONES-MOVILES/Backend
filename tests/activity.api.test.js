// Real Firestore transactions + deployed callable handlers, with a deterministic clock.
// Firebase verifies tokens at the HTTP boundary; these tests inject callable auth context.
const test = require("node:test");
const assert = require("node:assert/strict");
const {createRequire} = require("node:module");
const requireFunctions = createRequire(require.resolve("../functions/package.json"));
const {initializeApp, deleteApp} = requireFunctions("firebase-admin/app");
const {getFirestore} = requireFunctions("firebase-admin/firestore");
const {ActivityRepository} = require("../functions/src/activityRepository");
const {ActivityService} = require("../functions/src/activityService");
const {createActivityCallables} = require("../functions/src/activityCallables");
const {buildRecommendationInsight} = require("../functions/src/insights");

let app, db, api, repository, now;
const activityId = "a1";
const group = {
  memberIds: ["organizer", "member"], goingIds: ["organizer"], maybeIds: ["member"],
  members: ["organizer", "member"].map((id) => ({id, name: id, initials: id[0],
    busy: [], preferredStart: 600, preferredEnd: 720})),
};
const call = (name, data = {}, uid = "organizer") => api[name].run({
  data: {activityId, ...data}, auth: uid ? {uid} : undefined,
});
const generate = (options = {}) => call("getActivityRecommendations", {durationMinutes: 60, limit: 3, ...options});
const present = (result) => call("presentActivityRecommendations", {
  recommendationIds: result.recommendations.map((r) => r.id),
});
const accept = (id) => call("acceptActivityRecommendation", {recommendationId: id});
const modify = (id, startTime = "2026-10-02T18:00:00Z", endTime = "2026-10-02T19:00:00Z") =>
  call("modifyActivityRecommendation", {recommendationId: id, startTime, endTime});

test.before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "API tests require the Firestore emulator");
  app = initializeApp({projectId: "demo-parchapp"}, "activity-api-tests");
  db = getFirestore(app);
  repository = new ActivityRepository(db);
  api = createActivityCallables(new ActivityService(repository, {clock: () => now}));
});

test.beforeEach(async () => {
  now = new Date("2026-10-02T13:00:00Z");
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-parchapp/databases/(default)/documents`, {method: "DELETE"});
  assert.ok(response.ok);
  await db.doc("groups/g1").set(group);
  await db.doc("activities/a1").set({groupId: "g1", title: "Study", category: "study", description: "Review chapters",
    date: "", time: "", location: "Library", status: "PROPOSED", createdBy: "organizer", createdAt: now});
});

test.after(async () => {
  await db?.terminate();
  if (app) await deleteApp(app);
});

test("activity details work for members and legacy activities have explicit unknown times", async () => {
  const details = await call("getActivity", {}, "member");
  assert.equal(details.title, "Study");
  assert.equal(details.description, "Review chapters");
  assert.equal(details.startTime, null);
  assert.equal(details.durationMinutes, null);
  assert.deepEqual(details.participants.map((p) => p.availability), ["UNKNOWN", "UNKNOWN"]);
  assert.deepEqual(details.participants.map((p) => p.groupRsvpStatus), ["GOING", "MAYBE"]);
});

test("callables enforce authentication, membership, organizer ownership and IDs", async () => {
  await assert.rejects(call("getActivity", {}, null), {code: "unauthenticated"});
  await assert.rejects(call("getActivity", {}, "outsider"), {code: "permission-denied"});
  for (const name of ["getActivityRecommendations", "getActivityRecommendationAnalytics"]) {
    await assert.rejects(call(name, {}, "member"), {code: "permission-denied"});
  }
  await assert.rejects(call("getActivity", {activityId: "missing"}), {code: "not-found"});
  await assert.rejects(call("getActivity", {activityId: "groups/g1"}), {code: "invalid-argument"});
  await assert.rejects(generate({participants: ["organizer"]}), {code: "invalid-argument"});
  await assert.rejects(api.getActivity.run({data: null, auth: {uid: "organizer"}}), {code: "invalid-argument"});
});

test("generation, presentation and unchanged acceptance persist and count separately", async () => {
  const result = await generate();
  assert.equal(result.recommendations.length, 3);
  let metric = await call("getActivityRecommendationAnalytics");
  assert.equal(metric.recommendations_presented, 0);
  assert.equal(metric.pct_unchanged_overall, null);
  const id = result.recommendations[0].id;
  await assert.rejects(accept(id), {code: "failed-precondition"});
  await Promise.all([present(result), present(result)]);
  await Promise.all([accept(id), accept(id)]);
  metric = await call("getActivityRecommendationAnalytics");
  assert.equal(metric.recommendations_presented, 3);
  assert.equal(metric.accepted_recommendations_unchanged, 1);
  assert.equal(metric.pct_unchanged_overall, 33.3);
  const details = await call("getActivity");
  assert.equal(details.startTime, result.recommendations[0].startTime);
  assert.equal(details.durationMinutes, 60);
  assert.equal(details.date, "2026-10-02");
  assert.equal(details.time, "10:00");
  assert.deepEqual(details.participants.map((p) => p.availability), ["AVAILABLE", "AVAILABLE"]);
  assert.equal(details.status, "PROPOSED");
  await assert.rejects(accept(result.recommendations[1].id), {code: "failed-precondition"});
  await assert.rejects(modify(id), {code: "failed-precondition"});
});

test("modified choice updates schedule without increasing unchanged numerator", async () => {
  const result = await generate();
  await present(result);
  const id = result.recommendations[0].id;
  await modify(id);
  await modify(id);
  const metric = await call("getActivityRecommendationAnalytics");
  assert.equal(metric.accepted_recommendations_unchanged, 0);
  assert.equal(metric.pct_unchanged_overall, 0);
  assert.equal(metric.by_position[0].accepted, 1);
  assert.equal((await call("getActivity")).startTime, "2026-10-02T18:00:00.000Z");
});

test("concurrent conflicting decisions commit exactly one outcome for the whole batch", async () => {
  const result = await generate();
  await present(result);
  const outcomes = await Promise.allSettled([
    accept(result.recommendations[0].id), modify(result.recommendations[1].id),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const records = await db.collection("slotRecommendations").get();
  assert.equal(records.docs.filter((d) => d.data().outcome === "NOT_SELECTED").length, 2);
});

test("stale schedule or participant changes prevent acceptance without partial writes", async () => {
  const result = await generate();
  await present(result);
  const id = result.recommendations[0].id;
  await db.doc("groups/g1").update({members: group.members.map((m) => ({...m, busy: [{start: 600, end: 660}]}))});
  await assert.rejects(accept(id), {code: "failed-precondition"});
  assert.equal((await db.doc(`slotRecommendations/${id}`).get()).data().outcome, null);
  await db.doc("groups/g1").update({members: [group.members[0]]});
  await assert.rejects(accept(id), {code: "failed-precondition"});
  await db.doc("groups/g1").set(group);
  now = new Date("2026-10-02T15:00:00Z");
  await assert.rejects(accept(id), {code: "failed-precondition"});
});

test("decisions and presentations reject IDs from another activity and non-organizers", async () => {
  const result = await generate();
  const id = result.recommendations[0].id;
  await db.doc("activities/a2").set({...((await db.doc("activities/a1").get()).data())});
  await assert.rejects(call("presentActivityRecommendations", {activityId: "a2", recommendationIds: [id]}), {code: "not-found"});
  await assert.rejects(call("acceptActivityRecommendation", {activityId: "a2", recommendationId: id}), {code: "not-found"});
  await assert.rejects(call("presentActivityRecommendations", {recommendationIds: [id]}, "member"), {code: "permission-denied"});
  await assert.rejects(call("acceptActivityRecommendation", {recommendationId: id}, "member"), {code: "permission-denied"});
  await db.doc("groups/g1").update({memberIds: ["member"]});
  await assert.rejects(accept(id), {code: "permission-denied"});
});

test("invalid modification, fake acceptance times and future-day searches are rejected", async () => {
  const result = await generate();
  await present(result);
  const slot = result.recommendations[0];
  await assert.rejects(modify(slot.id, slot.startTime, slot.endTime), {code: "invalid-argument"});
  await assert.rejects(modify(slot.id, "not a date"), {code: "invalid-argument"});
  await assert.rejects(modify(slot.id, "2026-02-30T18:00:00Z"), {code: "invalid-argument"});
  await assert.rejects(modify(slot.id, "2026-10-01T24:00:00Z"), {code: "invalid-argument"});
  await assert.rejects(modify(slot.id, "2026-10-02T19:00:00Z", "2026-10-02T18:00:00Z"), {code: "invalid-argument"});
  await assert.rejects(call("acceptActivityRecommendation", {recommendationId: slot.id, startTime: slot.startTime}), {code: "invalid-argument"});
  await assert.rejects(generate({date: "2026-10-03"}), {code: "failed-precondition"});
  await assert.rejects(generate({durationMinutes: 0}), {code: "invalid-argument"});
});

test("only actually shown slots count, and closed batches cannot add new impressions", async () => {
  const result = await generate();
  const [first, second] = result.recommendations;
  await call("presentActivityRecommendations", {recommendationIds: [first.id]});
  await accept(first.id);
  await call("presentActivityRecommendations", {recommendationIds: [first.id]});
  await assert.rejects(call("presentActivityRecommendations", {recommendationIds: [second.id]}), {code: "failed-precondition"});
  assert.equal((await call("getActivityRecommendationAnalytics")).pct_unchanged_overall, 100);
});

test("retrying an old accepted batch never reverts a newer activity schedule", async () => {
  const old = await generate();
  await present(old);
  await accept(old.recommendations[0].id);
  const next = await generate();
  await present(next);
  await modify(next.recommendations[0].id);
  await accept(old.recommendations[0].id);
  assert.equal((await call("getActivity")).startTime, "2026-10-02T18:00:00.000Z");
});

test("nightly insight uses the presentation cohort and includes undecided suggestions", async () => {
  const result = await generate();
  await present(result);
  await accept(result.recommendations[0].id);
  await db.doc("slotRecommendations/old").set({position: 0, presentedAt: new Date("2026-08-01"), outcome: "ACCEPTED_UNCHANGED"});
  const rows = await repository.presentedSince(new Date("2026-09-02T13:00:00Z"), now);
  const insight = buildRecommendationInsight(rows);
  assert.equal(insight.recommendations_presented, 3);
  assert.equal(insight.pct_unchanged_overall, 33.3);
});

test("no feasible slots returns an empty list and creates no analytics records", async () => {
  await db.doc("groups/g1").update({members: group.members.map((m) => ({...m, busy: [{start: 0, end: 1440}]}))});
  assert.deepEqual((await generate()).recommendations, []);
  assert.equal((await db.collection("slotRecommendations").get()).size, 0);
});

test("invalid presentation lists cannot partially count impressions", async () => {
  const result = await generate();
  const id = result.recommendations[0].id;
  for (const recommendationIds of [[], [id, id], [id, "missing"]]) {
    await assert.rejects(call("presentActivityRecommendations", {recommendationIds}));
  }
  assert.equal((await call("getActivityRecommendationAnalytics")).recommendations_presented, 0);
});

test("Activity Details reports busy now and unknown outside today's schedule data", async () => {
  const result = await generate();
  await present(result);
  await accept(result.recommendations[0].id);
  await db.doc("groups/g1").update({members: group.members.map((m) => ({...m, busy: [{start: 600, end: 660}]}))});
  assert.deepEqual((await call("getActivity")).participants.map((p) => p.availability), ["BUSY", "BUSY"]);
  now = new Date("2026-10-03T13:00:00Z");
  assert.deepEqual((await call("getActivity")).participants.map((p) => p.availability), ["UNKNOWN", "UNKNOWN"]);
});
