// BQ9 (Gabriel): current stored busy intervals, never calendar content or users.
const INSIGHT_PATH = 'insights/bq9_google_calendar_adoption';
const {FieldValue} = require('firebase-admin/firestore');
const DAY = 86400000, MINUTE = 60000, OFFSET = 5 * 60 * MINUTE;

function normalizeSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.trim().toLowerCase() === 'unknown') return 'unknown';
  const value = source.trim().toLowerCase();
  return ['google', 'google_calendar'].includes(value) ? 'google_calendar' : 'other';
}
function dateStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms + OFFSET : NaN;
}
function millis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  return NaN;
}
function mergeIntervals(intervals) {
  const result = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && (interval.start < previous.end ||
        (interval.start === previous.end && interval.source === previous.source))) {
      previous.end = Math.max(previous.end, interval.end);
      if (previous.source !== interval.source) previous.source = 'unknown';
    } else result.push({...interval});
  }
  return result;
}

// Input is projected DocumentSnapshots. Exact paths exclude unrelated collection
// groups. Per owner/day precedence: day snapshot > private slots > shared slots.
// An explicit empty day overrides older slots and is not a missing observation.
function buildScheduleImportInsight(documents) {
  const days = new Map(), privateSlots = new Map(), sharedSlots = new Map();
  const seen = new Set();
  for (const doc of documents) {
    const path = doc.ref.path;
    if (seen.has(path)) continue;
    seen.add(path);
    const dayMatch = /^availability\/([^/]+)\/days\/([^/]+)$/.exec(path);
    const slotMatch = /^(schedules|availability)\/([^/]+)\/slots\/[^/]+$/.exec(path);
    if (!dayMatch && !slotMatch) continue;
    const data = doc.data();
    if (dayMatch) {
      const date = dayMatch[2];
      if (!Number.isFinite(dateStart(date)) || data.date !== date || !Array.isArray(data.busy)) continue;
      days.set(`${dayMatch[1]}/${date}`, data.busy.filter(b => b &&
        Number.isInteger(b.start) && Number.isInteger(b.end) && b.start >= 0 && b.end <= 1440 && b.start < b.end)
          .map(b => ({start: b.start, end: b.end, source: normalizeSource(data.source)})));
      continue;
    }
    const start = millis(data.start), end = millis(data.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
    // Bound corrupt ranges before iterating; supported imports are <= 56 days.
    if (end - start > 366 * DAY) continue;
    const target = slotMatch[1] === 'schedules' ? privateSlots : sharedSlots;
    for (let cursor = Math.floor((start - OFFSET) / DAY) * DAY + OFFSET; cursor < end; cursor += DAY) {
      const date = new Date(cursor - OFFSET).toISOString().slice(0, 10);
      const key = `${slotMatch[2]}/${date}`;
      const blocks = target.get(key) || [];
      blocks.push({start: (Math.max(start, cursor) - cursor) / MINUTE,
        end: (Math.min(end, cursor + DAY) - cursor) / MINUTE, source: normalizeSource(data.source)});
      target.set(key, blocks);
    }
  }
  const selected = new Map([...sharedSlots, ...privateSlots, ...days]);
  const counts = {totalSlots: 0, googleSlots: 0, otherSlots: 0, unknownSlots: 0};
  for (const blocks of selected.values()) {
    for (const block of mergeIntervals(blocks)) {
      counts.totalSlots++;
      counts[block.source === 'google_calendar' ? 'googleSlots' : block.source === 'other' ? 'otherSlots' : 'unknownSlots']++;
    }
  }
  return {...counts, percentage: counts.totalSlots ? Math.round(counts.googleSlots / counts.totalSlots * 10000) / 100 : null,
    measurement: 'stored_busy_intervals', scope: 'all_currently_stored_days',
    precedence: 'availability_days_then_private_slots_then_shared_slots'};
}

async function refreshScheduleImportInsight(db, {now} = {}) {
  // Transactional reads prevent a stale concurrent refresh overwriting a newer
  // snapshot. Replacements/deletions are read directly, with no derived index.
  return db.runTransaction(async tx => {
    const days = await tx.get(db.collectionGroup('days').select('date', 'busy', 'source'));
    const slots = await tx.get(db.collectionGroup('slots').select('start', 'end', 'source'));
    const insight = {...buildScheduleImportInsight([...days.docs, ...slots.docs]),
      updated_at: now ?? new Date()};
    tx.set(db.doc(INSIGHT_PATH), {...insight, updated_at: now ?? FieldValue.serverTimestamp()});
    return insight;
  });
}

module.exports = {INSIGHT_PATH, normalizeSource, buildScheduleImportInsight, refreshScheduleImportInsight};
