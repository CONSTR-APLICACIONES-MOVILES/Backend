const {requireThat, integer} = require("./errors");

const MINUTE = 60_000;
const TIME_ZONE = "America/Bogota";
// The current data model stores minutes in Bogota, which has no daylight saving time.
const OFFSET = "-05:00";

function localDate(now) {
  return new Date(now.getTime() - 5 * 60 * MINUTE).toISOString().slice(0, 10);
}

function dayStart(date) {
  return Date.parse(`${date}T00:00:00${OFFSET}`);
}

function hasSchedule(member) {
  return Array.isArray(member.busy) && member.busy.every((b) =>
    Number.isInteger(b.start) && Number.isInteger(b.end) &&
    b.start >= 0 && b.end <= 1440 && b.start < b.end);
}

function isAvailable(member, start, end) {
  return hasSchedule(member) && !member.busy.some((b) => start < b.end && end > b.start);
}

function normalizeContext(input, members, now) {
  const date = input.date ?? localDate(now);
  requireThat(date === localDate(now), "failed-precondition",
      "Only today's schedules in America/Bogota are available.");
  const durationMinutes = integer(input.durationMinutes, 15, 720, "durationMinutes");
  const minimumNoticeMinutes = integer(input.minimumNoticeMinutes ?? 60, 0, 1440, "minimumNoticeMinutes");
  const limit = integer(input.limit ?? 5, 1, 10, "limit");
  requireThat(members.length > 0 && members.every(hasSchedule), "failed-precondition",
      "Every participant must have valid free/busy data.");
  return {date, durationMinutes, minimumNoticeMinutes, limit, members, now};
}

class AvailabilityEngine {
  findSlots(context) {
    const {date, durationMinutes, minimumNoticeMinutes, members, now} = context;
    const midnight = dayStart(date);
    const earliest = Math.max(0, Math.ceil(
        ((now.getTime() - midnight) / MINUTE + minimumNoticeMinutes) / 15) * 15);
    const slots = [];
    for (let start = earliest; start + durationMinutes <= 1440; start += 15) {
      const end = start + durationMinutes;
      if (members.every((member) => isAvailable(member, start, end))) {
        slots.push({start, end});
      }
    }
    return slots;
  }
}

/** SlotRankingStrategy contract: rank(slots, context) returns ordered scored slots.
 * Inject another object with this method to replace the ranking policy.
 */
class ContextAwareSlotRankingStrategy {
  rank(slots, context) {
    const {members} = context;
    return slots.map((slot) => {
      const preferred = members.filter((member) =>
        Number.isInteger(member.preferredStart) && Number.isInteger(member.preferredEnd) &&
        member.preferredStart >= 0 && member.preferredEnd <= 1440 &&
        member.preferredStart < member.preferredEnd);
      const matches = preferred.filter((member) =>
        slot.start >= member.preferredStart && slot.end <= member.preferredEnd).length;
      const preferenceMatch = preferred.length ? matches / preferred.length : 0;
      return {
        ...slot,
        // Availability and notice are hard constraints; preferences distinguish feasible slots.
        score: Number((0.7 + 0.3 * preferenceMatch).toFixed(4)),
        reasons: ["All participants are available", "Meets minimum notice",
          preferred.length ? `Matches preferred hours for ${matches} of ${preferred.length} participants` :
            "No preferred hours supplied"],
      };
    }).sort((a, b) => b.score - a.score || a.start - b.start);
  }
}

function recommendationSlots(context, engine, ranker) {
  return ranker.rank(engine.findSlots(context), context).slice(0, context.limit).map((slot) => ({
    startTime: new Date(dayStart(context.date) + slot.start * MINUTE).toISOString(),
    endTime: new Date(dayStart(context.date) + slot.end * MINUTE).toISOString(),
    availableParticipants: context.members.length,
    totalParticipants: context.members.length,
    score: slot.score,
    reasons: slot.reasons,
  }));
}

module.exports = {AvailabilityEngine, ContextAwareSlotRankingStrategy, normalizeContext,
  recommendationSlots, localDate, dayStart, isAvailable, hasSchedule, MINUTE, TIME_ZONE};
