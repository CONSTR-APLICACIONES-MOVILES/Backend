const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FEATURES, percentile, buildEngineLatency, buildFeatureUsage, buildCreationAbandonment, buildComparisonConfirmation,
  refreshTeamInsights,
} = require("../src/teamInsights");

const engine = (size, ms) => ({name: "availability_calc", params: {group_size: size, duration_ms: ms}});
const feature = (name) => ({name: "feature_used", params: {feature: name, screen: "Test"}});

test("p90 is the value under which 90 percent of the values are", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 90), null);
});

test("bq1 groups the engine time by group size", () => {
  const insight = buildEngineLatency([engine(3, 10), engine(3, 30), engine(5, 50), feature("groups"),
    {name: "availability_calc", params: {group_size: 3}}]);
  assert.deepEqual(insight.by_group_size, [
    {group_size: 3, avg_ms: 20, p90_ms: 30, calculations: 2},
    {group_size: 5, avg_ms: 50, p90_ms: 50, calculations: 1},
  ]);
  assert.equal(insight.total_calculations, 3);
});

test("bq8 puts the least used feature first and keeps features with zero uses", () => {
  const insight = buildFeatureUsage([feature("groups"), feature("groups"), feature("schedule"), engine(3, 10)]);
  assert.equal(insight.total_uses, 3);
  assert.equal(insight.features.length, FEATURES.length);
  assert.equal(insight.features[0].uses, 0);
  assert.deepEqual(insight.features.at(-1), {feature: "groups", uses: 2, pct: 66.7});
  assert.equal(insight.least_used, insight.features[0].feature);
});

test("without events the dashboard gets empty insights, not an error", () => {
  assert.deepEqual(buildEngineLatency([]), {by_group_size: [], total_calculations: 0});
  const usage = buildFeatureUsage([]);
  assert.equal(usage.total_uses, 0);
  assert.equal(usage.least_used, null);
});

test("refresh reads the window and writes bq1, bq7, bq8 and bq9 without touching bq3", async () => {
  const written = {};
  let since;
  let activitiesSince;
  const db = {
    collection: (name) => {
      if (name === "activities") {
        return {where: (field, op, value) => {
          assert.equal(field, "createdAt");
          activitiesSince = value;
          return {get: async () => ({docs: [{id: "a1", data: () => ({status: "CONFIRMED"})}]})};
        }};
      }
      assert.equal(name, "analyticsEvents");
      return {where: (field, op, value) => {
        assert.equal(field, "created_at");
        since = value;
        return {get: async () => ({docs: [engine(3, 12), feature("alerts")].map((data) => ({data: () => data}))})};
      }};
    },
    doc: (path) => ({set: async (data) => { written[path] = data; }}),
  };
  const now = new Date("2026-10-29T12:00:00Z");
  const summary = await refreshTeamInsights(db, {now, extras: false});
  assert.deepEqual(Object.keys(written).sort(), ["insights/bq1_engine_latency", "insights/bq7_creation_abandonment",
    "insights/bq8_feature_usage", "insights/bq9_comparison_confirmation"]);
  assert.equal(written["insights/bq9_comparison_confirmation"].total_activities, 1);
  assert.equal(activitiesSince.toISOString(), "2026-09-29T12:00:00.000Z");
  assert.equal(written["insights/bq1_engine_latency"].total_events, 2);
  assert.equal(written["insights/bq8_feature_usage"].updated_at, now);
  assert.equal(written["insights/bq7_creation_abandonment"].total_flows, 0);
  assert.equal(since.toISOString(), "2026-09-29T12:00:00.000Z");
  assert.deepEqual(summary, {total_events: 2, calculations: 1, feature_uses: 1, creation_flows: 0, activities: 1});
});

// bq7 helpers: one attempt with its steps and an optional end
const flow = (id, steps, finished = false, test = false) => [
  {name: "creation_started", params: {flow_id: id, entry_point: "dashboard"}, test},
  ...steps.map((index) => ({name: "creation_step_viewed", params: {flow_id: id, step_index: index}, test})),
  ...(finished ? [{name: "creation_finished", params: {flow_id: id, total_ms: 30000}, test}] : []),
];

test("bq7 counts the abandons by the last step reached", () => {
  const insight = buildCreationAbandonment([
    ...flow("a", [1, 2, 3, 4, 5, 6], true),
    ...flow("b", [1, 2]),
    ...flow("c", [1, 2, 2, 1]),
    ...flow("d", []),
    ...flow("e", [1, 2, 3, 4, 5, 6]),
  ]);
  assert.equal(insight.total_flows, 5);
  assert.equal(insight.total_finished, 1);
  assert.equal(insight.abandon_rate, 80);
  const byName = Object.fromEntries(insight.steps.map((step) => [step.name, step]));
  assert.equal(byName.opened.abandoned, 1);
  assert.equal(byName.group.abandoned, 2);
  assert.equal(byName.group.percent, 40);
  assert.equal(byName.review.abandoned, 1);
  assert.equal(insight.most_abandoned_step, "group");
  assert.deepEqual(insight.steps.map((step) => step.index), [0, 1, 2, 3, 4, 5, 6]);
});

test("bq7 ignores steps without a start, other events and marks test attempts", () => {
  const insight = buildCreationAbandonment([
    {name: "creation_step_viewed", params: {flow_id: "lost", step_index: 3}},
    engine(3, 10),
    ...flow("t", [1], false, true),
  ]);
  assert.equal(insight.total_flows, 1);
  assert.equal(insight.test_flows, 1);
  assert.equal(insight.steps.find((step) => step.name === "details").abandoned, 1);
});

test("bq7 without attempts gives an empty result, not an error", () => {
  const insight = buildCreationAbandonment([]);
  assert.equal(insight.total_flows, 0);
  assert.equal(insight.abandon_rate, 0);
  assert.equal(insight.most_abandoned_step, null);
});

// bq9 helpers: the events the android app logs when it creates and sees a confirmed activity
const created = (id, source, extra = {}) => ({name: "activity_created", params: {activity_id: id, source, ...extra}});
const confirmed = (id) => ({name: "activity_confirmed", params: {activity_id: id}});

test("bq9 splits the activities by compare use and counts how many reach confirmed", () => {
  const insight = buildComparisonConfirmation([
    created("a1", "suggested_slot"), confirmed("a1"),
    created("a2", "suggested_slot"),
    created("a3", "group_activity"), confirmed("a3"),
    created("a4", "group_activity"), created("a5", "group_activity"),
  ]);
  assert.deepEqual(insight.groups, [
    {usage: "with_comparison", created: 2, confirmed: 1, confirmation_pct: 50},
    {usage: "without_comparison", created: 3, confirmed: 1, confirmation_pct: 33.3},
  ]);
  assert.equal(insight.total_activities, 5);
  assert.equal(insight.comparison_rate, 40);
  assert.equal(insight.confirmation_difference, 16.7);
});

test("bq9 uses the activity documents too: flutter comparisons and the real confirmed status", () => {
  const insight = buildComparisonConfirmation([created("f1", undefined, {comparison_id: "c1"})], [
    {id: "f1", status: "CONFIRMED"},
    {id: "w1", status: "PROPOSED", planningContext: {comparisonUsed: true}},
    {id: "w2", status: "CONFIRMED", planningContext: {comparisonUsed: false}},
  ]);
  assert.deepEqual(insight.groups[0], {usage: "with_comparison", created: 2, confirmed: 1, confirmation_pct: 50});
  assert.deepEqual(insight.groups[1], {usage: "without_comparison", created: 1, confirmed: 1, confirmation_pct: 100});
});

test("bq9 ignores confirmations without a created activity and marks test data", () => {
  const insight = buildComparisonConfirmation([confirmed("ghost"), {...created("t1", "suggested_slot"), test: true},
    {name: "activity_created", params: {}}]);
  assert.equal(insight.total_activities, 1);
  assert.equal(insight.test_flows, 1);
  assert.equal(insight.confirmation_difference, null);
});

test("bq9 without activities gives an empty result, not an error", () => {
  const insight = buildComparisonConfirmation([]);
  assert.equal(insight.total_activities, 0);
  assert.equal(insight.comparison_rate, 0);
  assert.equal(insight.confirmation_difference, null);
});
