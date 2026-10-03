const {randomUUID} = require("node:crypto");
const {requireThat, documentId} = require("./errors");
const {AvailabilityEngine, ContextAwareSlotRankingStrategy, normalizeContext, recommendationSlots,
  localDate, dayStart, isAvailable, hasSchedule, MINUTE, TIME_ZONE} = require("./availability");
const {buildRecommendationInsight} = require("./insights");

function iso(value) {
  if (!value) return null;
  return (value.toDate ? value.toDate() : new Date(value)).toISOString();
}

function authorize(context, uid, organizer = false) {
  requireThat(uid, "unauthenticated", "Sign in to continue.");
  requireThat(context.activity, "not-found", "Activity not found.");
  requireThat(context.group?.memberIds?.includes(uid), "permission-denied", "Group membership is required.");
  requireThat(!organizer || context.activity.createdBy === uid,
      "permission-denied", "Only the organizer can manage recommendations.");
}

function candidateDto(record) {
  const {id, startTime, endTime, availableParticipants, totalParticipants, score, reasons} = record;
  return {id, startTime, endTime, availableParticipants, totalParticipants, score, reasons};
}

function parseInstant(value, name) {
  requireThat(typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)), "invalid-argument", `${name} must be an ISO timestamp at minute precision.`);
  const calendarDate = value.slice(0, 10);
  requireThat(new Date(`${calendarDate}T00:00:00Z`).toISOString().slice(0, 10) === calendarDate &&
      Number(value.slice(11, 13)) < 24, "invalid-argument", `${name} must contain a valid calendar date and hour.`);
  return new Date(value);
}

class ActivityService {
  constructor(repository, {clock = () => new Date(), engine = new AvailabilityEngine(),
    ranker = new ContextAwareSlotRankingStrategy()} = {}) {
    this.repository = repository;
    this.clock = clock;
    this.engine = engine;
    this.ranker = ranker;
  }

  withActivity(uid, input, organizer, work) {
    requireThat(uid, "unauthenticated", "Sign in to continue.");
    documentId(input.activityId, "activityId");
    return this.repository.withActivity(input.activityId, async (context) => {
      authorize(context, uid, organizer);
      return work(context);
    });
  }

  getActivity(uid, input) {
    return this.withActivity(uid, input, false, ({activity, group}) => {
      const startTime = iso(activity.startTime);
      const endTime = iso(activity.endTime);
      const today = localDate(this.clock());
      const midnight = dayStart(today);
      const start = startTime ? (Date.parse(startTime) - midnight) / MINUTE : -1;
      const end = endTime ? (Date.parse(endTime) - midnight) / MINUTE : -1;
      const known = start >= 0 && start < end && end <= 1440;
      return {
        id: input.activityId, groupId: activity.groupId, createdBy: activity.createdBy,
        title: activity.title, description: activity.description ?? "", category: activity.category,
        date: activity.date ?? "", time: activity.time ?? "", startTime, endTime,
        durationMinutes: activity.durationMinutes ?? null, timeZone: TIME_ZONE,
        status: activity.status, location: activity.location ?? "",
        participants: group.members.map((member) => ({
          id: member.id, name: member.name, initials: member.initials ?? "",
          // Existing RSVP arrays are group-level, not activity attendance.
          groupRsvpStatus: group.goingIds?.includes(member.id) ? "GOING" :
            group.maybeIds?.includes(member.id) ? "MAYBE" : "NO_RESPONSE",
          availability: !known || !hasSchedule(member) ? "UNKNOWN" :
            isAvailable(member, start, end) ? "AVAILABLE" : "BUSY",
        })),
      };
    });
  }

  getActivityRecommendations(uid, input) {
    return this.withActivity(uid, input, true, ({activity, group, putRecommendation}) => {
      const now = this.clock();
      const context = normalizeContext({
        ...input, durationMinutes: input.durationMinutes ?? activity.durationMinutes,
      }, group.members, now);
      const batchId = randomUUID();
      const slots = recommendationSlots(context, this.engine, this.ranker);
      const recommendations = slots.map((slot, position) => {
        const id = randomUUID();
        const record = {
          ...slot, activityId: input.activityId, batchId, organizerId: uid, position,
          participantIds: group.members.map((member) => member.id).sort(),
          minimumNoticeMinutes: context.minimumNoticeMinutes,
          generatedAt: now, presentedAt: null, outcome: null, decidedAt: null,
        };
        putRecommendation(id, record);
        return candidateDto({id, ...record});
      });
      return {activityId: input.activityId, batchId, date: context.date, timeZone: TIME_ZONE,
        durationMinutes: context.durationMinutes, minimumNoticeMinutes: context.minimumNoticeMinutes,
        recommendations};
    });
  }

  presentActivityRecommendations(uid, input) {
    requireThat(Array.isArray(input.recommendationIds) && input.recommendationIds.length > 0 &&
        input.recommendationIds.length <= 10 && new Set(input.recommendationIds).size === input.recommendationIds.length,
    "invalid-argument", "Supply 1 to 10 distinct recommendationIds actually displayed.");
    input.recommendationIds.forEach((id) => documentId(id, "recommendationId"));
    return this.withActivity(uid, input, true, async ({getRecommendations, updateRecommendation}) => {
      const records = await getRecommendations(input.recommendationIds);
      records.forEach((record) => {
        requireThat(record?.activityId === input.activityId && record.organizerId === uid,
            "not-found", "Recommendation not found for this activity.");
        requireThat(record.presentedAt || !record.decidedAt, "failed-precondition", "This recommendation batch is closed.");
      });
      const now = this.clock();
      for (const record of records) {
        if (!record.presentedAt) updateRecommendation(record.id, {presentedAt: now});
      }
      return {presented: records.length};
    });
  }

  acceptActivityRecommendation(uid, input) {
    requireThat(input.startTime === undefined && input.endTime === undefined, "invalid-argument",
        "Use modifyActivityRecommendation to change the suggested times.");
    return this.decide(uid, input, "ACCEPTED_UNCHANGED");
  }

  modifyActivityRecommendation(uid, input) {
    return this.decide(uid, input, "MODIFIED");
  }

  decide(uid, input, outcome) {
    documentId(input.recommendationId, "recommendationId");
    const modifiedStart = outcome === "MODIFIED" ? parseInstant(input.startTime, "startTime") : null;
    const modifiedEnd = outcome === "MODIFIED" ? parseInstant(input.endTime, "endTime") : null;
    return this.withActivity(uid, input, true, async (context) => {
      const [record] = await context.getRecommendations([input.recommendationId]);
      requireThat(record?.activityId === input.activityId && record.organizerId === uid,
          "not-found", "Recommendation not found for this activity.");
      requireThat(record.presentedAt, "failed-precondition", "Acknowledge presentation before choosing a recommendation.");
      const startTime = modifiedStart?.toISOString() ?? record.startTime;
      const endTime = modifiedEnd?.toISOString() ?? record.endTime;
      if (record.decidedAt) {
        requireThat(record.outcome === outcome && record.selectedStartTime === startTime &&
            record.selectedEndTime === endTime, "failed-precondition", "This recommendation batch already has a decision.");
        return {recommendationId: record.id, outcome, startTime, endTime};
      }
      requireThat(outcome !== "MODIFIED" || startTime !== record.startTime || endTime !== record.endTime,
          "invalid-argument", "The modified interval must differ from the suggested interval.");
      const now = this.clock();
      const durationMinutes = (Date.parse(endTime) - Date.parse(startTime)) / MINUTE;
      const date = localDate(new Date(startTime));
      const slotContext = normalizeContext({date, durationMinutes,
        minimumNoticeMinutes: record.minimumNoticeMinutes}, context.group.members, now);
      requireThat(JSON.stringify(record.participantIds) ===
          JSON.stringify(context.group.members.map((member) => member.id).sort()),
      "failed-precondition", "Participants changed; generate new recommendations.");
      const start = (Date.parse(startTime) - dayStart(date)) / MINUTE;
      const end = (Date.parse(endTime) - dayStart(date)) / MINUTE;
      requireThat(end <= 1440 && Date.parse(startTime) >= now.getTime() + slotContext.minimumNoticeMinutes * MINUTE &&
          slotContext.members.every((member) => isAvailable(member, start, end)),
      "failed-precondition", "The selected interval no longer meets availability or minimum notice.");
      const batch = await context.getBatch(record.batchId);
      requireThat(batch.every((candidate) => !candidate.decidedAt), "failed-precondition",
          "This recommendation batch already has a decision.");
      for (const candidate of batch) {
        context.updateRecommendation(candidate.id, {
          outcome: candidate.id === record.id ? outcome : "NOT_SELECTED", decidedAt: now,
          selectedStartTime: startTime, selectedEndTime: endTime,
        });
      }
      context.updateActivity({
        startTime: new Date(startTime), endTime: new Date(endTime), durationMinutes,
        date, time: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
      });
      return {recommendationId: record.id, outcome, startTime, endTime};
    });
  }

  getActivityRecommendationAnalytics(uid, input) {
    return this.withActivity(uid, input, true, async ({listRecommendations}) =>
      ({activityId: input.activityId, ...buildRecommendationInsight(await listRecommendations())}));
  }
}

module.exports = {ActivityService};
