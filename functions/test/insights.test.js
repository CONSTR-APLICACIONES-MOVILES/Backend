const test = require("node:test");
const assert = require("node:assert/strict");
const {loadQuery, buildSlotInsight, DEFAULT_RECOMMENDED_POSITION, MIN_SAMPLE} = require("../src/insights");

function row(slotPosition, accepted, unchanged, isRecommended) {
  return {
    slot_position: slotPosition,
    accepted,
    accepted_unchanged: unchanged,
    pct_unchanged_overall: 70.5,
    is_recommended: isRecommended,
  };
}

test("picks the recommended position when there is enough data", () => {
  const insight = buildSlotInsight([row(0, 10, 4, false), row(1, 15, 12, true)]);
  assert.equal(insight.recommended_position, 1);
  assert.equal(insight.sample_size, 25);
  assert.equal(insight.pct_unchanged_overall, 70.5);
  assert.equal(insight.by_position.length, 2);
});

test("on a tie the lowest position wins", () => {
  const insight = buildSlotInsight([row(2, 10, 8, true), row(1, 12, 8, true)]);
  assert.equal(insight.recommended_position, 1);
});

test("keeps the default until the sample is large enough", () => {
  const insight = buildSlotInsight([row(2, MIN_SAMPLE - 1, 5, true)]);
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
