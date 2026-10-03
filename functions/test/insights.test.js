const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadQuery, buildSlotInsight, buildRecommendationInsight, buildResponseTimeInsight, DEFAULT_RECOMMENDED_POSITION,
  MIN_SAMPLE, MIN_COMPLETED, MIN_RESPONSES,
} = require("../src/insights");

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
  for (const file of ["bq1_availability_latency.sql", "bq3_slot_acceptance.sql", "bq5_response_time.sql",
    "bq8_feature_usage.sql"]) {
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

function sizeRow(groupSize, completed, responses, allResponded, perResponse) {
  return {
    group_size: groupSize,
    invitations: completed + 1,
    completed,
    pct_completed: 50,
    avg_minutes_all_responded: allResponded,
    median_minutes_all_responded: allResponded,
    responses,
    avg_minutes_per_response: perResponse,
  };
}

test("BQ5 uses the everyone-answered time when there are enough complete invitations", () => {
  const insight = buildResponseTimeInsight([sizeRow(4, MIN_COMPLETED, 20, 95.5, 30)]);
  assert.equal(insight.by_group_size[0].estimate_minutes, 95.5);
  assert.equal(insight.by_group_size[0].estimate_kind, "all_responded");
  assert.equal(insight.completed, MIN_COMPLETED);
});

test("BQ5 falls back to the time of one answer", () => {
  const insight = buildResponseTimeInsight([sizeRow(6, MIN_COMPLETED - 1, MIN_RESPONSES, null, 42)]);
  assert.equal(insight.by_group_size[0].estimate_minutes, 42);
  assert.equal(insight.by_group_size[0].estimate_kind, "per_response");
  assert.equal(insight.by_group_size[0].avg_minutes_all_responded, null);
});

test("BQ5 gives no estimate with too little data", () => {
  const insight = buildResponseTimeInsight([sizeRow(12, 0, MIN_RESPONSES - 1, null, 10)]);
  assert.equal(insight.by_group_size[0].estimate_minutes, null);
  assert.equal(insight.by_group_size[0].estimate_kind, null);
});

test("BQ5 with no events gives an empty document", () => {
  const insight = buildResponseTimeInsight([]);
  assert.deepEqual(insight.by_group_size, []);
  assert.equal(insight.invitations, 0);
});
