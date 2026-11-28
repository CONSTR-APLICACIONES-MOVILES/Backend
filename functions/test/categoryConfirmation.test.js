const test = require("node:test");
const assert = require("node:assert/strict");
const {summarize, validate, byDayOrWeek, sizeOf, getCategoryConfirmation} = require("../src/categoryConfirmation");

const NOW = new Date("2026-11-26T15:00:00Z"); // 10:00 in Bogota
// 2026-11-25 20:00 Bogota is already 2026-11-26 01:00 UTC: the day must be the Bogota one
const at = (iso) => ({toMillis: () => new Date(iso).getTime()});
const activity = (category, status, createdAt = "2026-11-20T17:00:00Z", size = 3) =>
  ({category, status, createdAt: at(createdAt), planningContext: {groupSizeAtCreation: size}});

test("summary counts activities and the confirmed percentage of each category", () => {
  const result = summarize([
    activity("study", "CONFIRMED"), activity("study", "PROPOSED"), activity("study", "CONFIRMED"),
    activity("sports", "PROPOSED"), activity("social", "CONFIRMED"),
  ]);
  assert.deepEqual(result.by_category[0], {category: "study", activities: 3, confirmed: 2, confirmation_pct: 66.7});
  assert.equal(result.total, 5);
  assert.equal(result.confirmed, 3);
  assert.equal(result.confirmation_pct, 60);
  assert.equal(result.most_used, "study");
  assert.equal(result.least_used, "sports"); // sports and social both have 1: ties are ordered by name, so sports is last
});

test("summary puts a missing or strange category in unknown and skips empty categories", () => {
  const result = summarize([activity(undefined, "CONFIRMED"), activity("chess", "PROPOSED")]);
  assert.deepEqual(result.by_category.map((r) => r.category), ["unknown"]);
  assert.equal(result.by_category[0].activities, 2);
});

test("summary of nothing has no ranking and no percentage", () => {
  assert.deepEqual(summarize([]), {by_category: [], total: 0, confirmed: 0, confirmation_pct: null,
    most_used: null, least_used: null});
});

test("with only one category it is the most used and there is no least used", () => {
  const result = summarize([activity("study", "CONFIRMED"), activity("study", "PROPOSED")]);
  assert.equal(result.most_used, "study");
  assert.equal(result.least_used, null);
  const two = summarize([activity("study", "CONFIRMED"), activity("study", "PROPOSED"), activity("sports", "PROPOSED")]);
  assert.equal(two.least_used, "sports"); // with two categories both are still ranked
});

test("a bad date range answers with a clear message", () => {
  const message = (input) => { try { validate(input, NOW); } catch (error) { return error.message; } return null; };
  assert.equal(message({from: "", to: ""}), "Choose a start and an end date.");
  assert.equal(message({from: "", to: "2026-11-26"}), "Choose a start and an end date.");
  assert.equal(message({from: "2026-11-20", to: ""}), "Choose a start and an end date.");
  assert.equal(message({from: "2026-11-20", to: "2026-11-10"}), "The start date must be before the end date.");
  assert.equal(message({from: "2026-08-01", to: "2026-11-26"}), "The range can be at most 90 days.");
});

test("group size buckets", () => {
  assert.deepEqual([1, 2, 3, 4, 6, 7, 20].map(sizeOf), ["solo", "2-3", "2-3", "4-6", "4-6", "7+", "7+"]);
  assert.equal(sizeOf(undefined), "unknown");
  assert.equal(sizeOf(0), "unknown");
});

test("without filters the last 30 days up to today are read, in Bogota time", () => {
  const f = validate({}, NOW);
  assert.equal(f.toDate, "2026-11-26");
  assert.equal(f.fromDate, "2026-10-28");
  assert.equal(f.from, Date.parse("2026-10-28T05:00:00Z"));
  assert.equal(f.until, Date.parse("2026-11-27T05:00:00Z"));
  assert.deepEqual([f.granularity, f.size, f.category], ["day", "all", "all"]);
});

test("filters reject reversed dates, more than 90 days, fake dates and values outside the lists", () => {
  const code = (input) => { try { validate(input, NOW); } catch (error) { return error.code; } return null; };
  assert.equal(code({from: "2026-11-20", to: "2026-11-10"}), "invalid-argument");
  assert.equal(code({from: "2026-08-01", to: "2026-11-26"}), "invalid-argument"); // 118 days
  assert.equal(code({from: "2026-02-30", to: "2026-03-05"}), "invalid-argument");
  assert.equal(code({from: "26-11-2026", to: "2026-11-26"}), "invalid-argument");
  assert.equal(code({granularity: "month"}), "invalid-argument");
  assert.equal(code({size: "8+"}), "invalid-argument");
  assert.equal(code({category: "unknown"}), "invalid-argument");
  assert.equal(code({category: "study", extra: true}), "invalid-argument");
  assert.equal(code(null), "invalid-argument");
  assert.equal(code({from: "2026-08-29", to: "2026-11-26"}), null); // exactly 90 days
  assert.equal(code({from: "2026-11-26", to: "2026-11-26"}), null); // one day
});

test("timeline by day uses the Bogota date of the creation", () => {
  const rows = byDayOrWeek([
    activity("study", "CONFIRMED", "2026-11-26T01:00:00Z"), // 2026-11-25 20:00 in Bogota
    activity("study", "PROPOSED", "2026-11-25T15:00:00Z"),
    activity("sports", "PROPOSED", "2026-11-26T15:00:00Z"),
  ], {granularity: "day"});
  assert.deepEqual(rows.map((r) => [r.period, r.total]), [["2026-11-25", 2], ["2026-11-26", 1]]);
  assert.equal(rows[0].confirmed, 1);
});

test("timeline by week starts on Monday", () => {
  const rows = byDayOrWeek([
    activity("study", "PROPOSED", "2026-11-22T17:00:00Z"), // Sunday 2026-11-22
    activity("study", "PROPOSED", "2026-11-23T17:00:00Z"), // Monday
    activity("study", "CONFIRMED", "2026-11-29T17:00:00Z"), // Sunday
  ], {granularity: "week"});
  assert.deepEqual(rows.map((r) => [r.period, r.total]), [["2026-11-16", 1], ["2026-11-23", 2]]);
});

// a small Firestore double: only the calls getCategoryConfirmation makes
function fakeDb(docs) {
  const calls = [];
  const query = {
    where(field, op, value) { calls.push([field, op, value.getTime()]); return query; },
    limit() { return query; },
    async get() { return {size: docs.length, docs: docs.map((data) => ({data: () => data}))}; },
  };
  return {calls, collection: (name) => { calls.push(name); return query; }};
}

test("the function filters by group size and category and answers with the summary and the timeline", async () => {
  const db = fakeDb([
    activity("study", "CONFIRMED", "2026-11-20T17:00:00Z", 3),
    activity("study", "PROPOSED", "2026-11-20T17:00:00Z", 8),
    activity("sports", "CONFIRMED", "2026-11-21T17:00:00Z", 3),
  ]);
  const all = await getCategoryConfirmation(db, {}, NOW);
  assert.equal(all.summary.total, 3);
  assert.equal(db.calls[0], "activities");
  assert.deepEqual(db.calls[1], ["createdAt", ">=", Date.parse("2026-10-28T05:00:00Z")]);

  const small = await getCategoryConfirmation(db, {size: "2-3", category: "study"}, NOW);
  assert.equal(small.summary.total, 1);
  assert.equal(small.summary.confirmation_pct, 100);
  assert.equal(small.timeline.length, 1);
  assert.equal(small.truncated, false);
  assert.match(small.explanation, /CONFIRMED now/);
});
