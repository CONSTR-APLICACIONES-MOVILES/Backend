const test = require("node:test");
const assert = require("node:assert/strict");
const {loadQuery, buildSlotInsight, buildRecommendationInsight, DEFAULT_RECOMMENDED_POSITION, MIN_SAMPLE} = require("../src/insights");

function row(slotPosition, accepted, unchanged) {
  return {
    slot_position: slotPosition,
    accepted,
    presented: accepted,
    accepted_unchanged: unchanged,
  };
}

test("picks the recommended position when there is enough data", () => {
  const insight = buildSlotInsight([row(0, 10, 4), row(1, 15, 12)]);
  assert.equal(insight.recommended_position, 1);
  assert.equal(insight.sample_size, 25);
  assert.equal(insight.pct_unchanged_overall, 64);
  assert.equal(insight.by_position.length, 2);
});

test("on a tie the lowest position wins", () => {
  const insight = buildSlotInsight([row(2, 10, 8), row(1, 10, 8)]);
  assert.equal(insight.recommended_position, 1);
});

test("keeps the default until the sample is large enough", () => {
  const insight = buildSlotInsight([row(2, MIN_SAMPLE - 1, 5)]);
  assert.equal(insight.recommended_position, DEFAULT_RECOMMENDED_POSITION);
});

test("no events gives the default", () => {
  const insight = buildSlotInsight([]);
  assert.equal(insight.recommended_position, DEFAULT_RECOMMENDED_POSITION);
  assert.equal(insight.sample_size, 0);
  assert.equal(insight.pct_unchanged_overall, null);
});

test("every SQL file points at the real export dataset after loading", () => {
  for (const file of ["bq1_availability_latency.sql", "bq3_slot_acceptance.sql", "bq8_feature_usage.sql"]) {
    const sql = loadQuery(file, "my-project", "analytics_123");
    assert.match(sql, /`my-project\.analytics_123\.events_\*`/);
    assert.doesNotMatch(sql, /FROM `parchapp.analytics_PROPERTY_ID/);
  }
});

test("BQ3 includes unselected and undecided presentations, excluding generated-only slots", () => {
  const insight = buildRecommendationInsight([
    {position: 0, presentedAt: new Date(), outcome: "ACCEPTED_UNCHANGED"},
    {position: 1, presentedAt: new Date(), outcome: "NOT_SELECTED"},
    {position: 2, presentedAt: new Date(), outcome: null},
    {position: 0, presentedAt: new Date(), outcome: "MODIFIED"},
    {position: 0, presentedAt: null, outcome: null},
  ]);
  assert.equal(insight.recommendations_presented, 4);
  assert.equal(insight.accepted_recommendations_unchanged, 1);
  assert.equal(insight.pct_unchanged_overall, 25);
});

test("feedback compares acceptance rates, not raw acceptance counts", () => {
  const insight = buildSlotInsight([
    {...row(0, 10, 10), presented: 100},
    {...row(1, 5, 5), presented: 10},
  ]);
  assert.equal(insight.recommended_position, 1);
});
