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

// reads the events of the window, writes bq1 and bq8 and gives back a short summary
// bq3 is not written here, it has its own function
async function refreshTeamInsights(db, {now = new Date(), serverTime} = {}) {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const snapshot = await db.collection(EVENTS).where("created_at", ">=", since).get();
  const events = snapshot.docs.map((doc) => doc.data());
  const common = {total_events: events.length, window_start: since, window_end: now, updated_at: serverTime ?? now};
  const engine = buildEngineLatency(events);
  const usage = buildFeatureUsage(events);
  await db.doc("insights/bq1_engine_latency").set({...engine, ...common});
  await db.doc("insights/bq8_feature_usage").set({...usage, ...common});
  const coordination = await require('./coordinationInsights').refreshCoordinationInsight(db, now);
  const responseTime = await require('./responseTimeInsights').refreshResponseTimeInsight(db, now);
  return {total_events: events.length, calculations: engine.total_calculations, feature_uses: usage.total_uses,
    coordination_activities:coordination.total, response_time_invitations:responseTime.invitations};
}

module.exports = {FEATURES, WINDOW_DAYS, percentile, buildEngineLatency, buildFeatureUsage, refreshTeamInsights};
