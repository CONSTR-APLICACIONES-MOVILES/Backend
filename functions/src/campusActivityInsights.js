const {CAMPUS_AREAS} = require("./campusAreas");

const BUCKETS = ["morning", "afternoon", "evening", "night"];

function buildCampusActivityAreas(activities) {
  const names = new Map(CAMPUS_AREAS.map((area) => [area.id, area.name]));
  const cells = new Map();
  let confirmed = 0;
  for (const activity of activities) {
    if (activity.status !== "CONFIRMED" || activity.cancelled === true) continue;
    if (activity.analyticsEnvironment === "test") continue;
    const area = activity.planningContext?.locationAreaId || "unknown";
    const bucket = activity.planningContext?.timeBucket || "unknown";
    const key = `${area}|${bucket}`;
    cells.set(key, (cells.get(key) || 0) + 1);
    confirmed++;
  }
  const rows = [...cells.entries()].map(([key, count]) => {
    const [area, bucket] = key.split("|");
    return {
      area_id: area,
      area: names.get(area) || "Unknown area",
      time_bucket: bucket,
      confirmed: count,
      pct: confirmed ? Math.round((1000 * count) / confirmed) / 10 : 0,
    };
  }).sort((a, b) => b.confirmed - a.confirmed || a.area.localeCompare(b.area));
  return {rows, total_confirmed: confirmed, top: rows[0] || null, buckets: BUCKETS};
}

module.exports = {buildCampusActivityAreas};