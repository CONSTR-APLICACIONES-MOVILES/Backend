const test = require("node:test");
const assert = require("node:assert/strict");
const {validate, getCreationFunnel} = require("../src/creationFunnel");

const NOW = new Date("2026-11-26T15:00:00Z"); // 10:00 in Bogota
const at = (iso) => ({toMillis: () => new Date(iso).getTime()});
const started = (flow, iso, entry = "dashboard", extra = {}) =>
  ({name: "creation_started", params: {flow_id: flow, entry_point: entry}, created_at: at(iso), ...extra});
const step = (flow, index, iso, extra = {}) =>
  ({name: "creation_step_viewed", params: {flow_id: flow, step_index: index}, created_at: at(iso), ...extra});
const finished = (flow, iso, extra = {}) =>
  ({name: "creation_finished", params: {flow_id: flow}, created_at: at(iso), ...extra});

function fakeDb(docs) {
  const calls = [];
  const query = {
    where(field, op, value) { calls.push([field, op, value.getTime()]); return query; },
    limit() { return query; },
    async get() { return {size: docs.length, docs: docs.map((data) => ({data: () => data}))}; },
  };
  return {calls, collection: (name) => { calls.push(name); return query; }};
}

const EVENTS = [
  // a1 reaches step 3 and leaves, a2 finishes, a3 opens and leaves at once (all real, from the dashboard)
  started("a1", "2026-11-20T17:00:00Z"), step("a1", 1, "2026-11-20T17:01:00Z"), step("a1", 2, "2026-11-20T17:02:00Z"),
  step("a1", 3, "2026-11-20T17:03:00Z"),
  started("a2", "2026-11-20T18:00:00Z"), step("a2", 1, "2026-11-20T18:01:00Z"), finished("a2", "2026-11-20T18:05:00Z"),
  started("a3", "2026-11-21T10:00:00Z"),
  // b1 starts from group details and leaves at the place step
  started("b1", "2026-11-22T10:00:00Z", "group_details"), step("b1", 5, "2026-11-22T10:03:00Z"),
  // t1 is test data
  started("t1", "2026-11-22T11:00:00Z", "dashboard", {test: true}), step("t1", 4, "2026-11-22T11:01:00Z", {test: true}),
  // events that are not part of a creation flow, and steps of a flow that never started
  {name: "feature_used", params: {feature: "groups"}, created_at: at("2026-11-22T11:00:00Z")},
  step("orphan", 2, "2026-11-22T12:00:00Z"),
];

test("without filters the last 30 days are read, real data only", async () => {
  const db = fakeDb(EVENTS);
  const result = await getCreationFunnel(db, {}, NOW);
  assert.equal(db.calls[0], "analyticsEvents");
  assert.deepEqual(db.calls[1], ["created_at", ">=", Date.parse("2026-10-28T05:00:00Z")]);
  assert.equal(result.filters.data, "real");
  assert.equal(result.summary.total_flows, 4); // a1, a2, a3, b1: the test flow and the orphan steps are out
  assert.equal(result.summary.total_finished, 1);
  assert.equal(result.summary.abandon_rate, 75);
  assert.equal(result.truncated, false);
});

test("the timeline has one summary for each day, oldest first", async () => {
  const result = await getCreationFunnel(fakeDb(EVENTS), {}, NOW);
  assert.deepEqual(result.timeline.map((r) => [r.period, r.total_flows]), [["2026-11-20", 2], ["2026-11-21", 1], ["2026-11-22", 1]]);
  assert.equal(result.timeline[0].total_finished, 1);
});

test("by week the flows are grouped from the Monday", async () => {
  const result = await getCreationFunnel(fakeDb(EVENTS), {granularity: "week"}, NOW);
  assert.deepEqual(result.timeline.map((r) => [r.period, r.total_flows]), [["2026-11-16", 4]]);
});

test("the entry point filter keeps one entry, and the selector lists all of them", async () => {
  const result = await getCreationFunnel(fakeDb(EVENTS), {entry: "group_details"}, NOW);
  assert.equal(result.summary.total_flows, 1);
  assert.equal(result.summary.most_abandoned_step, "place");
  assert.deepEqual(result.entry_points, ["dashboard", "group_details"]);
});

test("test data can be read alone or together with the real data", async () => {
  const testOnly = await getCreationFunnel(fakeDb(EVENTS), {data: "test"}, NOW);
  assert.equal(testOnly.summary.total_flows, 1);
  const all = await getCreationFunnel(fakeDb(EVENTS), {data: "all"}, NOW);
  assert.equal(all.summary.total_flows, 5);
});

test("steps that stop the same number of attempts are all reported as a tie, in the order of the form", async () => {
  // from the dashboard a3 stops at opened and a1 at duration: one each
  const tie = await getCreationFunnel(fakeDb(EVENTS), {entry: "dashboard"}, NOW);
  assert.deepEqual(tie.summary.most_abandoned_steps, ["opened", "duration"]);
  assert.equal(tie.summary.most_abandoned_step, "opened"); // the old field keeps naming the first one
  assert.deepEqual(tie.timeline[0].most_abandoned_steps, ["duration"]); // day 20: a1 stops at duration, a2 finished
  const single = await getCreationFunnel(fakeDb(EVENTS), {entry: "group_details"}, NOW);
  assert.deepEqual(single.summary.most_abandoned_steps, ["place"]);
  const nobody = await getCreationFunnel(fakeDb([started("f1", "2026-11-20T17:00:00Z"), finished("f1", "2026-11-20T17:05:00Z")]), {}, NOW);
  assert.deepEqual(nobody.summary.most_abandoned_steps, []);
});

test("the step where most attempts stop is reported", async () => {
  const result = await getCreationFunnel(fakeDb(EVENTS), {entry: "dashboard"}, NOW);
  // a1 stops at step 3 (duration), a3 at step 0 (opened), a2 finished
  assert.equal(result.summary.total_flows, 3);
  assert.equal(result.summary.steps.find((s) => s.name === "opened").abandoned, 1);
  assert.equal(result.summary.steps.find((s) => s.name === "duration").abandoned, 1);
});

test("a bad date range answers with a clear message", () => {
  const message = (input) => { try { validate(input, NOW); } catch (error) { return error.message; } return null; };
  assert.equal(message({from: "", to: ""}), "Choose a start and an end date.");
  assert.equal(message({from: "", to: "2026-11-26"}), "Choose a start and an end date.");
  assert.equal(message({from: "2026-11-20", to: ""}), "Choose a start and an end date.");
  assert.equal(message({from: "2026-11-20", to: "2026-11-10"}), "The start date must be before the end date.");
  assert.equal(message({from: "2026-08-01", to: "2026-11-26"}), "The range can be at most 90 days.");
});

test("filters reject reversed dates, more than 90 days, fake dates and values outside the lists", () => {
  const code = (input) => { try { validate(input, NOW); } catch (error) { return error.code; } return null; };
  assert.equal(code({from: "2026-11-20", to: "2026-11-10"}), "invalid-argument");
  assert.equal(code({from: "2026-08-01", to: "2026-11-26"}), "invalid-argument");
  assert.equal(code({from: "2026-02-30", to: "2026-03-05"}), "invalid-argument");
  assert.equal(code({granularity: "month"}), "invalid-argument");
  assert.equal(code({data: "fake"}), "invalid-argument");
  assert.equal(code({entry: "Bad Entry!"}), "invalid-argument");
  assert.equal(code({entry: "dashboard", extra: 1}), "invalid-argument");
  assert.equal(code(null), "invalid-argument");
  assert.equal(code({from: "2026-08-29", to: "2026-11-26"}), null);
});
