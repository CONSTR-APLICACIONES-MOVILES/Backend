// bq10: activities by category, and how many of each category reach CONFIRMED, with filters
const {requireThat} = require("./errors");

const DAY = 86400000;
const BOGOTA_OFFSET_MS = 5 * 3600000; // America/Bogota is UTC-5 all year, there is no daylight saving time
const MAX_DAYS = 90;
const MAX_ACTIVITIES = 10000;
const CATEGORIES = ["study", "sports", "social", "other", "unknown"];
const FILTER_CATEGORIES = ["all", "study", "sports", "social", "other"];
const SIZES = ["all", "solo", "2-3", "4-6", "7+"];
const GRANULARITIES = ["day", "week"];
const INPUT_FIELDS = ["from", "to", "granularity", "size", "category"];

const sizeOf = (n) => !Number.isInteger(n) || n < 1 ? "unknown" : n === 1 ? "solo" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : "7+";
const categoryOf = (a) => CATEGORIES.includes(a.category) ? a.category : "unknown";

// "2026-11-26" -> the start of that day in Bogota, as a number; null if it is not a real date
function dayStart(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc.getTime() + BOGOTA_OFFSET_MS;
}

// the Bogota calendar date of a moment, "2026-11-26"
function bogotaDate(millis) {
  return new Date(millis - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

// from/to are dates (both included, max 90 days); the rest are lists. Without from/to: the last 30 days.
function validate(input = {}, now = new Date()) {
  requireThat(input !== null && typeof input === "object" && !Array.isArray(input),
      "invalid-argument", "The filters must be an object.");
  requireThat(Object.keys(input).every((key) => INPUT_FIELDS.includes(key)),
      "invalid-argument", "The filters contain unsupported fields.");
  const granularity = input.granularity ?? "day";
  const size = input.size ?? "all";
  const category = input.category ?? "all";
  requireThat(GRANULARITIES.includes(granularity), "invalid-argument", "Group by must be day or week.");
  requireThat(SIZES.includes(size), "invalid-argument", "Group size must be all, solo, 2-3, 4-6 or 7+.");
  requireThat(FILTER_CATEGORIES.includes(category), "invalid-argument", "Category must be all, study, sports, social or other.");

  const today = bogotaDate(now.getTime());
  const toText = input.to ?? today;
  const fromText = input.from ?? bogotaDate(dayStart(toText) - 29 * DAY);
  const from = dayStart(fromText);
  const to = dayStart(toText);
  requireThat(from !== null && to !== null, "invalid-argument", "Dates must look like 2026-11-26.");
  requireThat(from <= to, "invalid-argument", "The start date must not be after the end date.");
  requireThat((to - from) / DAY + 1 <= MAX_DAYS, "invalid-argument", `Choose at most ${MAX_DAYS} days.`);
  return {from, until: to + DAY, fromDate: fromText, toDate: toText, granularity, size, category};
}

function summarize(activities) {
  const rows = CATEGORIES.map((category) => {
    const own = activities.filter((a) => categoryOf(a) === category);
    const confirmed = own.filter((a) => a.status === "CONFIRMED").length;
    return {category, activities: own.length, confirmed,
      confirmation_pct: own.length ? Math.round((confirmed / own.length) * 1000) / 10 : null};
  }).filter((r) => r.activities > 0)
      .sort((a, b) => b.activities - a.activities || a.category.localeCompare(b.category));
  const confirmed = rows.reduce((sum, r) => sum + r.confirmed, 0);
  return {by_category: rows, total: activities.length, confirmed,
    confirmation_pct: activities.length ? Math.round((confirmed / activities.length) * 1000) / 10 : null,
    most_used: rows.length ? rows[0].category : null,
    least_used: rows.length ? rows[rows.length - 1].category : null};
}

const millisOf = (activity) => {
  const created = activity.createdAt;
  return created && typeof created.toMillis === "function" ? created.toMillis() : new Date(created).getTime();
};

// the day, or the Monday of the week, of the creation date (Bogota)
function periodOf(activity, granularity) {
  const day = bogotaDate(millisOf(activity));
  if (granularity === "day") return day;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 is Sunday
  return bogotaDate(dayStart(day) - ((weekday + 6) % 7) * DAY);
}

// one summary for each day or week that has activities, oldest first
function byDayOrWeek(activities, filters, summary = summarize) {
  const groups = new Map();
  for (const activity of activities) {
    const period = periodOf(activity, filters.granularity);
    if (!groups.has(period)) groups.set(period, []);
    groups.get(period).push(activity);
  }
  return [...groups.keys()].sort().map((period) => ({period, ...summary(groups.get(period))}));
}

async function getCategoryConfirmation(db, input = {}, now = new Date()) {
  const f = validate(input, now); // from/to (max 90 days), granularity day|week, size, category
  const snapshot = await db.collection("activities")
      .where("createdAt", ">=", new Date(f.from)).where("createdAt", "<", new Date(f.until))
      .limit(MAX_ACTIVITIES).get();
  const activities = snapshot.docs.map((d) => d.data())
      .filter((a) => f.size === "all" || sizeOf(a.planningContext?.groupSizeAtCreation) === f.size)
      .filter((a) => f.category === "all" || categoryOf(a) === f.category);
  return {
    filters: {from: f.fromDate, to: f.toDate, granularity: f.granularity, size: f.size, category: f.category},
    summary: summarize(activities),
    timeline: byDayOrWeek(activities, f, summarize),
    truncated: snapshot.size >= MAX_ACTIVITIES,
    explanation: "Cohorts by creation date (Bogota time). An activity counts as confirmed if its status is CONFIRMED now; " +
        "recent activities may still be confirmed later. Categories with no activities in the period are not ranked.",
  };
}

// the callable for index.js: same guard as the other dashboard callables (organization accounts only, because it
// reads every activity), and a bad filter answers invalid-argument instead of an internal error
function categoryConfirmationCallable(getDb) {
  const {onCall, HttpsError} = require("firebase-functions/v2/https");
  const {ServiceError} = require("./errors");
  const {requireOrganizationAnalytics} = require("./organizationAccess");
  return onCall({region: "us-central1", invoker: "public"}, async (request) => {
    requireOrganizationAnalytics(request);
    try {
      return await getCategoryConfirmation(getDb(), request.data || {});
    } catch (error) {
      if (error instanceof ServiceError) throw new HttpsError(error.code, error.message);
      throw error;
    }
  });
}

module.exports = {summarize, validate, byDayOrWeek, sizeOf, getCategoryConfirmation, categoryConfirmationCallable, CATEGORIES};
