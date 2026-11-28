// bq9 explorer: comparison usage and confirmation with the same cohort filters as the dashboard.
const {localDate, dayStart} = require('./availability');
const {asDate} = require('./coordinationInsights');

const DAY = 86400000;
const SIZES = ['solo', '2-3', '4-6', '7+', 'unknown'];
const CATEGORIES = ['study', 'sports', 'social', 'other', 'unknown'];
const COMPARISONS = ['with_comparison', 'without_comparison', 'unknown'];

const sizeOf = (n) => !Number.isInteger(n) || n < 1 ? 'unknown' :
  n === 1 ? 'solo' : n <= 3 ? '2-3' : n <= 6 ? '4-6' : '7+';
const categoryOf = (value) => CATEGORIES.includes(value) ? value : 'unknown';
const comparisonOf = (value) => value === true ? 'with_comparison' :
  value === false ? 'without_comparison' : 'unknown';
const percentage = (n, d) => d ? Math.round((n / d) * 1000) / 10 : null;

function groupDate(day, granularity) {
  if (granularity === 'day') return day;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return localDate(new Date(dayStart(day) - ((weekday + 6) % 7) * DAY));
}

function comparisonGroups(rows, filters) {
  const groups = {
    with_comparison: {created: 0, confirmed: 0},
    without_comparison: {created: 0, confirmed: 0},
    unknown: {created: 0, confirmed: 0},
  };
  let confirmed = 0;
  for (const row of rows) {
    const created = asDate(row.createdAt);
    const confirmedAt = asDate(row.firstConfirmedAt);
    const isConfirmed = Boolean(created && confirmedAt && confirmedAt >= created &&
      confirmedAt.getTime() <= created.getTime() + filters.confirmationDays * DAY);
    const usage = comparisonOf(row.comparisonUsed);
    groups[usage].created++;
    if (isConfirmed) {
      groups[usage].confirmed++;
      confirmed++;
    }
  }
  const known = groups.with_comparison.created + groups.without_comparison.created;
  const withRate = percentage(groups.with_comparison.confirmed, groups.with_comparison.created);
  const withoutRate = percentage(groups.without_comparison.confirmed, groups.without_comparison.created);
  const group = (usage, value) => ({
    usage,
    created: value.created,
    confirmed: value.confirmed,
    confirmation_pct: percentage(value.confirmed, value.created),
  });
  return {
    total_activities: rows.length,
    confirmed,
    confirmation_pct: percentage(confirmed, rows.length),
    known,
    unknown: groups.unknown.created,
    coverage_pct: percentage(known, rows.length),
    comparison_rate: percentage(groups.with_comparison.created, known),
    compared: group('with_comparison', groups.with_comparison),
    direct: group('without_comparison', groups.without_comparison),
    unknown_usage: group('unknown', groups.unknown),
    groups: [
      group('with_comparison', groups.with_comparison),
      group('without_comparison', groups.without_comparison),
      group('unknown', groups.unknown),
    ],
    difference_pp: withRate === null || withoutRate === null ? null :
      Math.round((withRate - withoutRate) * 10) / 10,
  };
}

function segment(rows, filters, key, value) {
  const own = rows.filter((row) => key(row) === value);
  const summary = comparisonGroups(own, filters);
  return {
    segment: value,
    total_activities: summary.total_activities,
    confirmed: summary.confirmed,
    confirmation_pct: summary.confirmation_pct,
    known: summary.known,
    coverage_pct: summary.coverage_pct,
    comparison_rate: summary.comparison_rate,
    compared: summary.compared,
    direct: summary.direct,
  };
}

function summarize(rows, filters) {
  const summary = comparisonGroups(rows, filters);
  return {
    ...summary,
    by_category: CATEGORIES.map((category) => segment(rows, filters, (row) => categoryOf(row.category), category))
        .filter((row) => row.total_activities > 0),
    by_size: SIZES.map((size) => segment(rows, filters, (row) => sizeOf(row.groupSize), size))
        .filter((row) => row.total_activities > 0),
  };
}

// Pure aggregation. It never returns activity IDs, names or the comparison participants.
function buildCoordinationAnalytics(rows, filters, now = new Date(), env = 'production') {
  const from = dayStart(filters.from);
  const until = Math.min(dayStart(filters.to) + DAY - 1, +now);
  const unique = new Map();
  for (const row of rows) {
    if (!row.activityId || (row.environment || 'production') !== env) continue;
    const created = asDate(row.createdAt);
    if (!created || created.getTime() < from || created.getTime() > until) continue;
    if (!unique.has(row.activityId)) unique.set(row.activityId, row);
  }
  const available = [...unique.values()];
  const matched = available.filter((row) =>
    (filters.size === 'all' || sizeOf(row.groupSize) === filters.size) &&
    (filters.category === 'all' || categoryOf(row.category) === filters.category) &&
    (filters.comparison === 'all' || comparisonOf(row.comparisonUsed) === filters.comparison));
  const buckets = new Map();
  for (let t = from; t <= until; t += DAY) {
    buckets.set(groupDate(localDate(new Date(t)), filters.granularity), []);
  }
  for (const row of matched) {
    const created = asDate(row.createdAt);
    buckets.get(groupDate(localDate(created), filters.granularity))?.push(row);
  }
  const timeline = [...buckets].map(([date, bucketRows]) => ({
    date,
    ...comparisonGroups(bucketRows, filters),
  }));
  return {
    schemaVersion: 1,
    question: 'bq9',
    filters,
    environment: env,
    updatedAt: now.toISOString(),
    available: available.length,
    matched: matched.length,
    excludedByFilters: available.length - matched.length,
    summary: summarize(matched, filters),
    timeline,
    explanation: 'Cohorts by creation date in Bogota. Comparison is taken from the activity measurement; ' +
      'unknown means the comparison cannot be attributed. Confirmation is counted only when the first ' +
      'confirmation happened inside the selected window. Rates exclude unknown comparison records from ' +
      'their denominator. This is observational, not causal.',
  };
}

module.exports = {
  buildCoordinationAnalytics,
  comparisonGroups,
  comparisonOf,
  categoryOf,
  sizeOf,
  groupDate,
  SIZES,
  CATEGORIES,
  COMPARISONS,
};
