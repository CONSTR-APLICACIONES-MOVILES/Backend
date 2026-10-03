const test = require("node:test");
const assert = require("node:assert/strict");
const {AvailabilityEngine, ContextAwareSlotRankingStrategy, normalizeContext,
  recommendationSlots, localDate} = require("../src/availability");

const now = new Date("2026-10-02T13:00:00Z"); // 08:00 Bogota
const engine = new AvailabilityEngine();
const ranker = new ContextAwareSlotRankingStrategy();
const member = (id, busy = [], preferredStart = 600, preferredEnd = 720) =>
  ({id, busy, preferredStart, preferredEnd});
const context = (members, options = {}) => normalizeContext({durationMinutes: 60,
  minimumNoticeMinutes: 60, ...options}, members, now);

test("engine intersects schedules and allows adjacent intervals", () => {
  const slots = engine.findSlots(context([
    member("a", [{start: 0, end: 600}, {start: 720, end: 1440}]),
    member("b", [{start: 0, end: 660}, {start: 780, end: 1440}]),
  ]));
  assert.deepEqual(slots, [{start: 660, end: 720}]);
});

test("ranking prefers shared preferred hours and breaks ties by earliest start", () => {
  const ranked = ranker.rank([{start: 720, end: 780}, {start: 630, end: 690},
    {start: 600, end: 660}, {start: 570, end: 630}], context([
    member("a"), member("b", [], 570, 660),
  ]));
  assert.deepEqual(ranked.map((slot) => slot.start), [600, 570, 630, 720]);
  assert.deepEqual(ranked.map((slot) => slot.score), [1, 0.85, 0.85, 0.7]);
  assert.ok(ranked[0].reasons.includes("Matches preferred hours for 2 of 2 participants"));
});

test("notice rounds upward to grid, handles seconds and bounds the end of day", () => {
  const ctx = normalizeContext({durationMinutes: 60, minimumNoticeMinutes: 60}, [member("a")],
      new Date("2026-10-02T13:00:01Z"));
  const slots = engine.findSlots(ctx);
  assert.equal(slots[0].start, 555);
  assert.equal(slots.at(-1).end, 1440);
  assert.deepEqual(engine.findSlots({...ctx, now: new Date("2026-10-03T04:30:00Z")}), []);
});

test("fully busy participants produce no candidates", () => {
  assert.deepEqual(engine.findSlots(context([member("a", [{start: 0, end: 1440}])])), []);
});

test("candidate DTOs use UTC instants, counts, bounded scores and requested limit", () => {
  const slots = recommendationSlots(context([member("a"), member("b")], {limit: 2}), engine, ranker);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].startTime, "2026-10-02T15:00:00.000Z");
  assert.equal(slots[0].endTime, "2026-10-02T16:00:00.000Z");
  assert.equal(slots[0].availableParticipants, 2);
  assert.equal(slots[0].totalParticipants, 2);
  assert.ok(slots.every((slot) => slot.score >= 0 && slot.score <= 1));
});

test("missing preferred hours are neutral, not a claimed match", () => {
  const [slot] = ranker.rank([{start: 600, end: 660}], context([{id: "a", busy: []}]));
  assert.equal(slot.score, 0.7);
  assert.ok(slot.reasons.includes("No preferred hours supplied"));
});

test("invalid inputs and missing availability are rejected", () => {
  for (const options of [{durationMinutes: 0}, {durationMinutes: 30.5}, {durationMinutes: "60"},
    {limit: 11}, {minimumNoticeMinutes: -1}, {date: "2026-10-03"}]) {
    assert.throws(() => context([member("a")], options));
  }
  for (const members of [[], [{id: "a"}], [member("a", [{start: 100, end: 50}])]]) {
    assert.throws(() => context(members), {code: "failed-precondition"});
  }
});

test("today is computed in Bogota even across UTC midnight", () => {
  assert.equal(localDate(new Date("2026-10-03T02:00:00Z")), "2026-10-02");
});
