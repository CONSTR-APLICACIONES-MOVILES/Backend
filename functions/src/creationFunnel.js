// bq7 with filters: at which step of the new activity form do users abandon, by period, day or week, entry point and data kind
const {requireThat} = require("./errors");
const {buildCreationAbandonment} = require("./teamInsights");
const {DAY, MAX_DAYS, dayStart, bogotaDate} = require("./categoryConfirmation");

const EVENTS = "analyticsEvents";
const MAX_EVENTS = 20000;
const GRANULARITIES = ["day", "week"];
const DATA_KINDS = ["real", "test", "all"];
const INPUT_FIELDS = ["from", "to", "granularity", "entry", "data"];
const CREATION_EVENTS = ["creation_started", "creation_step_viewed", "creation_finished"];

const millisOf = (event) => {
  const created = event.created_at;
  return created && typeof created.toMillis === "function" ? created.toMillis() : new Date(created).getTime();
};

// from/to are dates (both included, max 90 days); the rest are lists. Without from/to: the last 30 days.
function validate(input = {}, now = new Date()) {
  requireThat(input !== null && typeof input === "object" && !Array.isArray(input),
      "invalid-argument", "The filters must be an object.");
  requireThat(Object.keys(input).every((key) => INPUT_FIELDS.includes(key)),
      "invalid-argument", "The filters contain unsupported fields.");
  const granularity = input.granularity ?? "day";
  const entry = input.entry ?? "all";
  const data = input.data ?? "real";
  requireThat(GRANULARITIES.includes(granularity), "invalid-argument", "Group by must be day or week.");
  requireThat(DATA_KINDS.includes(data), "invalid-argument", "Data must be real, test or all.");
  requireThat(typeof entry === "string" && /^[a-z0-9_]{1,40}$/.test(entry),
      "invalid-argument", "Entry point must be all or a lower case name.");
  const toText = input.to ?? bogotaDate(now.getTime());
  const fromText = input.from ?? bogotaDate(dayStart(toText) - 29 * DAY);
  const from = dayStart(fromText);
  const to = dayStart(toText);
  requireThat(fromText !== "" && toText !== "", "invalid-argument", "Choose a start and an end date.");
  requireThat(from !== null && to !== null, "invalid-argument", "Dates must look like 2026-11-26.");
  requireThat(from <= to, "invalid-argument", "The start date must be before the end date.");
  requireThat((to - from) / DAY + 1 <= MAX_DAYS, "invalid-argument", `The range can be at most ${MAX_DAYS} days.`);
  return {from, until: to + DAY, fromDate: fromText, toDate: toText, granularity, entry, data};
}

// the day, or the Monday of the week, of a moment (Bogota)
function periodOf(millis, granularity) {
  const day = bogotaDate(millis);
  if (granularity === "day") return day;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 is Sunday
  return bogotaDate(dayStart(day) - ((weekday + 6) % 7) * DAY);
}

// buildCreationAbandonment names only one step when several stop the same number of attempts (the first of the form);
// this adds the list of all the steps with that top number, in the order of the form, empty when nobody abandoned
function withTies(summary) {
  const top = Math.max(0, ...summary.steps.map((step) => step.abandoned));
  const tied = top > 0 ? [...summary.steps].filter((step) => step.abandoned === top)
      .sort((a, b) => a.index - b.index).map((step) => step.name) : [];
  return {...summary, most_abandoned_steps: tied};
}

// one flow is every event with the same flow_id; it belongs to the period where it started
function groupFlows(events, filters) {
  const flows = new Map();
  for (const event of events) {
    if (!CREATION_EVENTS.includes(event.name)) continue;
    const id = event.params?.flow_id;
    if (typeof id !== "string" || !id) continue;
    if (!flows.has(id)) flows.set(id, {events: [], startedAt: null, entry: null, test: false});
    const flow = flows.get(id);
    flow.events.push(event);
    if (event.test === true) flow.test = true;
    if (event.name === "creation_started") {
      flow.startedAt = millisOf(event);
      flow.entry = event.params?.entry_point ?? null;
    }
  }
  return [...flows.values()].filter((flow) => flow.startedAt !== null
      && (filters.data === "all" || (filters.data === "test") === flow.test)
      && (filters.entry === "all" || flow.entry === filters.entry));
}

async function getCreationFunnel(db, input = {}, now = new Date()) {
  const f = validate(input, now);
  const snapshot = await db.collection(EVENTS)
      .where("created_at", ">=", new Date(f.from)).where("created_at", "<", new Date(f.until))
      .limit(MAX_EVENTS).get();
  const events = snapshot.docs.map((d) => d.data());
  // the entry points that exist in the window (before the entry filter), for the selector of the page
  const everyFlow = groupFlows(events, {...f, entry: "all"});
  const entryPoints = [...new Set(everyFlow.map((flow) => flow.entry).filter(Boolean))].sort();
  const flows = groupFlows(events, f);
  const byPeriod = new Map();
  for (const flow of flows) {
    const period = periodOf(flow.startedAt, f.granularity);
    if (!byPeriod.has(period)) byPeriod.set(period, []);
    byPeriod.get(period).push(...flow.events);
  }
  return {
    filters: {from: f.fromDate, to: f.toDate, granularity: f.granularity, entry: f.entry, data: f.data},
    summary: withTies(buildCreationAbandonment(flows.flatMap((flow) => flow.events))),
    timeline: [...byPeriod.keys()].sort().map((period) => ({period, ...withTies(buildCreationAbandonment(byPeriod.get(period)))})),
    entry_points: entryPoints,
    truncated: snapshot.size >= MAX_EVENTS,
    explanation: "An attempt starts when the New Activity form opens and counts as abandoned if the activity is never created. " +
        "Each attempt belongs to the day or week (Bogota time) where it started, and its last step says where the user stopped.",
  };
}

// the callable for index.js: organization accounts only, because it reads raw events
function creationFunnelCallable(getDb) {
  const {onCall, HttpsError} = require("firebase-functions/v2/https");
  const {ServiceError} = require("./errors");
  const {requireOrganizationAnalytics} = require("./organizationAccess");
  return onCall({region: "us-central1", invoker: "public"}, async (request) => {
    requireOrganizationAnalytics(request);
    try {
      return await getCreationFunnel(getDb(), request.data || {});
    } catch (error) {
      if (error instanceof ServiceError) throw new HttpsError(error.code, error.message);
      throw error;
    }
  });
}

module.exports = {validate, groupFlows, withTies, getCreationFunnel, creationFunnelCallable};
