const test = require("node:test");
const assert = require("node:assert/strict");
const {buildCampusActivityAreas} = require("../src/campusActivityInsights");

const activity = (status, area, bucket, extra = {}) =>
  ({status, planningContext: {locationAreaId: area, timeBucket: bucket}, ...extra});

test("confirmed activities are counted by campus area and time period", () => {
  const insight = buildCampusActivityAreas([
    activity("CONFIRMED", "central_library", "afternoon"),
    activity("CONFIRMED", "central_library", "afternoon"),
    activity("CONFIRMED", "campus_north", "evening"),
    activity("PROPOSED", "central_library", "afternoon"),
    activity("CONFIRMED", "campus_south", "morning", {cancelled: true}),
    activity("CONFIRMED", "campus_south", "morning", {analyticsEnvironment: "test"}),
  ]);
  assert.equal(insight.total_confirmed, 3);
  assert.equal(insight.top.area, "Central Library");
  assert.equal(insight.top.time_bucket, "afternoon");
  assert.equal(insight.top.confirmed, 2);
  assert.equal(insight.top.pct, 66.7);
});

test("activities without a planning context fall into unknown", () => {
  const insight = buildCampusActivityAreas([{status: "CONFIRMED"}]);
  assert.equal(insight.rows[0].area, "Unknown area");
  assert.equal(insight.rows[0].time_bucket, "unknown");
});

test("no confirmed activities gives an empty insight", () => {
  const insight = buildCampusActivityAreas([activity("PROPOSED", "campus_north", "night")]);
  assert.equal(insight.total_confirmed, 0);
  assert.equal(insight.top, null);
});