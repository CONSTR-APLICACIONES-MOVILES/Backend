// bq7 with the firestore emulator: real documents in analyticsEvents, the real refresh, the real insight document
// run with: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test tests/teamInsights.emulator.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {createRequire} = require("node:module");
const requireFunctions = createRequire(require.resolve("../functions/package.json"));
const {initializeApp, deleteApp} = requireFunctions("firebase-admin/app");
const {getFirestore} = requireFunctions("firebase-admin/firestore");
const {refreshTeamInsights} = require("../functions/src/teamInsights");

// a date far from the real data, so the 30 day window only sees the documents of this test
const now = new Date("2031-03-15T12:00:00Z");
const ids = [];
let app;
let db;

test.before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "This test needs the Firestore emulator");
  app = initializeApp({projectId: "demo-parchapp"}, "team-insights-emulator-test");
  db = getFirestore(app);
  const add = async (name, params) => {
    const ref = await db.collection("analyticsEvents").add({name, params, user_hash: null,
      created_at: new Date(now.getTime() - 60 * 60 * 1000)});
    ids.push(ref.id);
  };
// one complete attempt, one abandon in group and one abandon before touching anything
  await add("creation_started", {flow_id: "emu-a", entry_point: "dashboard"});
  for (const index of [1, 2, 3, 4, 5, 6]) await add("creation_step_viewed", {flow_id: "emu-a", step_index: index});
  await add("creation_finished", {flow_id: "emu-a", total_ms: 42000});
  await add("creation_started", {flow_id: "emu-b", entry_point: "group"});
  await add("creation_step_viewed", {flow_id: "emu-b", step_index: 1});
  await add("creation_step_viewed", {flow_id: "emu-b", step_index: 2});
  await add("creation_started", {flow_id: "emu-c", entry_point: "slot"});
// bq9: one plan from compare that got confirmed and one without compare that did not
  await add("activity_created", {activity_id: "emu-act-1", source: "suggested_slot"});
  await add("activity_confirmed", {activity_id: "emu-act-1"});
  await add("activity_created", {activity_id: "emu-act-2", source: "group_activity"});
});

test.after(async () => {
  await Promise.all(ids.map((id) => db.doc(`analyticsEvents/${id}`).delete()));
  await db?.terminate();
  if (app) await deleteApp(app);
});

test("refresh writes insights/bq7_creation_abandonment from the events in firestore", async () => {
  const summary = await refreshTeamInsights(db, {now, extras: false});
  assert.equal(summary.creation_flows, 3);
  const insight = (await db.doc("insights/bq7_creation_abandonment").get()).data();
  assert.equal(insight.total_flows, 3);
  assert.equal(insight.total_finished, 1);
  assert.equal(insight.abandon_rate, 66.7);
  assert.equal(insight.steps.find((step) => step.name === "group").abandoned, 1);
  assert.equal(insight.steps.find((step) => step.name === "opened").abandoned, 1);
  assert.ok(insight.updated_at);
});

test("refresh writes insights/bq9_comparison_confirmation from the events in firestore", async () => {
  await refreshTeamInsights(db, {now, extras: false});
  const insight = (await db.doc("insights/bq9_comparison_confirmation").get()).data();
  assert.equal(insight.total_activities, 2);
  assert.equal(insight.comparison_rate, 50);
  assert.deepEqual(insight.groups.map((row) => row.confirmation_pct), [100, 0]);
  assert.equal(insight.confirmation_difference, 100);
});
