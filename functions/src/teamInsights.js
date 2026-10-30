// team dashboard insights, they are made from the documents the app writes in analyticsEvents
const EVENTS = "analyticsEvents";
const ENGINE_EVENT = "availability_calc";
const FEATURE_EVENT = "feature_used";
// same names as AnalyticsEvents.FEATURE_* in the android app, a feature with zero uses still shows
const FEATURES = ["groups", "compare_availability", "schedule", "invitations", "alerts"];
// the dashboard looks at the last 30 days
const WINDOW_DAYS = 30;

const round = (value) => Math.round(value * 10) / 10;

// the value under which p percent of the values are
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// bq1: average and p90 of the engine time for each group size
function buildEngineLatency(events) {
  const bySize = new Map();
  for (const event of events) {
    if (event.name !== ENGINE_EVENT) continue;
    const size = Number(event.params?.group_size);
    const ms = Number(event.params?.duration_ms);
    if (!Number.isFinite(size) || !Number.isFinite(ms) || ms < 0) continue;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(ms);
  }
  const rows = [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([size, values]) => ({
    group_size: size,
    avg_ms: round(values.reduce((sum, ms) => sum + ms, 0) / values.length),
    p90_ms: percentile(values, 90),
    calculations: values.length,
  }));
  return {by_group_size: rows, total_calculations: rows.reduce((sum, row) => sum + row.calculations, 0)};
}

// bq8: uses and percent of each feature, the least used goes first
function buildFeatureUsage(events) {
  const uses = new Map(FEATURES.map((feature) => [feature, 0]));
  for (const event of events) {
    if (event.name !== FEATURE_EVENT) continue;
    const feature = event.params?.feature;
    if (typeof feature !== "string" || !feature) continue;
    uses.set(feature, (uses.get(feature) || 0) + 1);
  }
  const total = [...uses.values()].reduce((sum, count) => sum + count, 0);
  const features = [...uses.entries()]
      .map(([feature, count]) => ({feature, uses: count, pct: total ? round((100 * count) / total) : 0}))
      .sort((a, b) => a.uses - b.uses || a.feature.localeCompare(b.feature));
  return {features, total_uses: total, least_used: total ? features[0].feature : null};
}

// bq7: steps of the new activity form, the same names and order as CreationFlowTracker.Step in the app
// opened is index 0, the user opened the form and left before touching any field
const CREATION_STEPS = [
  {name: "opened", index: 0}, {name: "details", index: 1}, {name: "group", index: 2},
  {name: "duration", index: 3}, {name: "date_time", index: 4}, {name: "place", index: 5}, {name: "review", index: 6},
];
const CREATION_EVENTS = ["creation_started", "creation_step_viewed", "creation_finished"];

// bq7: one attempt for each flow_id with creation_started, the highest step says how far it went
// an attempt without creation_finished is an abandon, we count the abandons by their last step
function buildCreationAbandonment(events) {
  const flows = new Map();
  for (const event of events) {
    if (!CREATION_EVENTS.includes(event.name)) continue;
    const flowId = event.params?.flow_id;
    if (typeof flowId !== "string" || !flowId) continue;
    if (!flows.has(flowId)) flows.set(flowId, {started: false, finished: false, lastStep: 0, test: false});
    const flow = flows.get(flowId);
    if (event.name === "creation_started") flow.started = true;
    if (event.name === "creation_finished") flow.finished = true;
    if (event.name === "creation_step_viewed") {
      const index = Number(event.params?.step_index);
      if (Number.isInteger(index) && index > flow.lastStep && index <= 6) flow.lastStep = index;
    }
    if (event.test === true) flow.test = true;
  }
  const attempts = [...flows.values()].filter((flow) => flow.started);
  const total = attempts.length;
  const finished = attempts.filter((flow) => flow.finished).length;
  const steps = CREATION_STEPS.map((step) => {
    const abandoned = attempts.filter((flow) => !flow.finished && flow.lastStep === step.index).length;
    return {name: step.name, index: step.index, abandoned, percent: total ? round((100 * abandoned) / total) : 0};
  });
  const worst = [...steps].sort((a, b) => b.abandoned - a.abandoned || a.index - b.index)[0];
  return {
    steps,
    total_flows: total,
    total_finished: finished,
    abandon_rate: total ? round((100 * (total - finished)) / total) : 0,
    most_abandoned_step: worst && worst.abandoned > 0 ? worst.name : null,
// the dashboard shows a test data label when some attempts come from the seed
    test_flows: attempts.filter((flow) => flow.test).length,
  };
}

// bq9: the same event names and source as AnalyticsEvents in the android app
const CREATED_EVENT = "activity_created";
const CONFIRMED_EVENT = "activity_confirmed";
const SUGGESTED_SLOT = "suggested_slot";
const ACTIVITIES = "activities";

// bq9: one row per activity, from the activity_created events and from the activities documents
// with comparison: the event came from a Compare Availability slot (android) or has a comparison_id (flutter),
// or the activity was published with a planning comparison
// confirmed: the activity is CONFIRMED in firestore, or a phone logged activity_confirmed for it
function buildComparisonConfirmation(events, activities = []) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, {created: false, comparison: false, confirmed: false, test: false});
    return rows.get(id);
  };
  const confirmedByEvent = new Set();
  for (const event of events) {
    const id = event.params?.activity_id;
    if (typeof id !== "string" || !id) continue;
    if (event.name === CREATED_EVENT) {
      const activity = row(id);
      activity.created = true;
      if (event.params.source === SUGGESTED_SLOT || event.params.comparison_id) activity.comparison = true;
      if (event.test === true) activity.test = true;
    } else if (event.name === CONFIRMED_EVENT) {
      confirmedByEvent.add(id);
    }
  }
  for (const doc of activities) {
    if (!doc.id) continue;
    const activity = row(doc.id);
    activity.created = true;
    if (doc.planningContext?.comparisonUsed === true) activity.comparison = true;
    if (doc.status === "CONFIRMED") activity.confirmed = true;
  }
  for (const id of confirmedByEvent) {
    if (rows.has(id)) rows.get(id).confirmed = true;
  }
  const created = [...rows.values()].filter((activity) => activity.created);
  const group = (usage, comparison) => {
    const list = created.filter((activity) => activity.comparison === comparison);
    const confirmed = list.filter((activity) => activity.confirmed).length;
    return {usage, created: list.length, confirmed, confirmation_pct: list.length ? round((100 * confirmed) / list.length) : 0};
  };
  const withComparison = group("with_comparison", true);
  const withoutComparison = group("without_comparison", false);
  return {
    groups: [withComparison, withoutComparison],
    total_activities: created.length,
// how often compare is used before creating an activity
    comparison_rate: created.length ? round((100 * withComparison.created) / created.length) : 0,
// how many points more (or less) activities reach confirmed when compare was used, null until both groups have data
    confirmation_difference: withComparison.created && withoutComparison.created ?
      round(withComparison.confirmation_pct - withoutComparison.confirmation_pct) : null,
    test_flows: created.filter((activity) => activity.test).length,
  };
}

// reads the events and the activities of the window, writes bq1, bq7, bq8 and bq9 and gives back a short summary
// bq3 is not written here, it has its own function
async function refreshTeamInsights(db, {now = new Date(), serverTime, extras = true} = {}) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [snapshot, activitySnapshot] = await Promise.all([
    db.collection(EVENTS).where("created_at", ">=", since).get(),
    db.collection(ACTIVITIES).where("createdAt", ">=", since).get(),
  ]);
  const events = snapshot.docs.map((doc) => doc.data());
  const activities = activitySnapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  const common = {total_events: events.length, window_start: since, window_end: now, updated_at: serverTime ?? now};
  const engine = buildEngineLatency(events);
  const usage = buildFeatureUsage(events);
  const creation = buildCreationAbandonment(events);
  const comparison = buildComparisonConfirmation(events, activities);
  await db.doc("insights/bq1_engine_latency").set({...engine, ...common});
  await db.doc("insights/bq8_feature_usage").set({...usage, ...common});
  await db.doc("insights/bq7_creation_abandonment").set({...creation, ...common});
  await db.doc("insights/bq9_comparison_confirmation").set({...comparison, ...common});
  const areas = require("./campusActivityInsights").buildCampusActivityAreas(activities);
  await db.doc("insights/bq11_confirmed_activity_areas").set({...areas, ...common});
  const summary = {total_events: events.length, calculations: engine.total_calculations, feature_uses: usage.total_uses,
    creation_flows: creation.total_flows, activities: comparison.total_activities};
// the same refresh also updates the coordination and response time insights of main
// the unit tests use a fake database, so they can turn this part off
  if (!extras) return summary;
  const coordination = await require("./coordinationInsights").refreshCoordinationInsight(db, now);
  const responseTime = await require("./responseTimeInsights").refreshResponseTimeInsight(db, now);
  return {...summary, coordination_activities: coordination.total, response_time_invitations: responseTime.invitations};
}

module.exports = {FEATURES, WINDOW_DAYS, CREATION_STEPS, percentile, buildEngineLatency, buildFeatureUsage,
  buildCreationAbandonment, buildComparisonConfirmation, refreshTeamInsights};
