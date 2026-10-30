const test = require("node:test");
const assert = require("node:assert/strict");
const {chooseRsvpReminderDelay, EXPLORE_BUCKETS, EXPLORE_OUT_OF} = require("../src/reminderTiming");

test("reminder assignment is stable, uses eligible delays, and explores alternatives", () => {
  const counts = new Map([[30, 0], [60, 0], [120, 0]]);
  for (let i = 0; i < 200; i++) {
    const participantId = `participant-${i}`;
    const delay = chooseRsvpReminderDelay("activity-1", participantId, 60, 180);
    assert.ok([30, 60, 120].includes(delay));
    assert.equal(delay, chooseRsvpReminderDelay("activity-1", participantId, 60, 180));
    counts.set(delay, counts.get(delay) + 1);
  }
  assert.ok(counts.get(60) >= 140);
  assert.ok(counts.get(30) > 0);
  assert.ok(counts.get(120) > 0);
  assert.equal(EXPLORE_BUCKETS / EXPLORE_OUT_OF, 0.2);
});

test("does not schedule a reminder after the activity start or inside the 30-minute minimum", () => {
  assert.equal(chooseRsvpReminderDelay("a", "u", 60, 30), null);
  assert.equal(chooseRsvpReminderDelay("a", "u", 60, 29), null);
  const delay = chooseRsvpReminderDelay("a", "u", 120, 61);
  assert.equal(delay, 60);
  assert.ok(delay < 61);
});

test("falls back to the default delay if the published insight is invalid", () => {
  const activityId = "activity-default-test";
  const participantId = Array.from({length: 100}, (_, i) => `user-${i}`)
      .find(id => chooseRsvpReminderDelay(activityId, id, 60, 61) === 60);
  assert.ok(participantId);
  assert.equal(chooseRsvpReminderDelay(activityId, participantId, 999, 61), 60);
});
