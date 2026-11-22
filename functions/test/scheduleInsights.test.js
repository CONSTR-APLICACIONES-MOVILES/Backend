const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeSource, buildScheduleImportInsight: build, refreshScheduleImportInsight: refresh,
  INSIGHT_PATH} = require('../src/scheduleInsights');
const {createScheduleInsightCallable} = require('../src/scheduleInsightCallables');

const day = (uid, source, busy = [{start: 600, end: 660}]) => ({
  ref: {path: `availability/${uid}/days/2030-11-13`},
  data: () => ({date: '2030-11-13', source, busy}),
});
const slot = (path, source, start = '2030-11-13T15:00:00Z', end = '2030-11-13T16:00:00Z') => ({
  ref: {path}, data: () => ({source, start: new Date(start), end: new Date(end),
    title: 'PRIVATE TITLE', description: 'PRIVATE DESCRIPTION', location: 'PRIVATE LOCATION'}),
});
function fakeDb(initial = []) {
  let records = initial;
  const written = new Map();
  return {
    written,
    replace: next => { records = next; },
    collectionGroup: group => ({select: (...fields) => ({group, fields})}),
    doc: path => ({path}),
    runTransaction: async work => work({
      get: async query => {
        assert.deepEqual(query.fields, query.group === 'days' ? ['date', 'busy', 'source'] : ['start', 'end', 'source']);
        return {docs: records.filter(d => d.ref.path.split('/').at(-2) === query.group)};
      },
      set: (ref, data) => written.set(ref.path, data),
    }),
  };
}

test('normalizes Google aliases, other origins, missing and unknown sources', () => {
  for (const source of ['google', 'google_calendar', ' GOOGLE_CALENDAR ']) assert.equal(normalizeSource(source), 'google_calendar');
  for (const source of [null, undefined, '', 'unknown', 123]) assert.equal(normalizeSource(source), 'unknown');
  for (const source of ['manual', 'demo', 'outlook']) assert.equal(normalizeSource(source), 'other');
});
test('percentage uses all valid intervals including unknowns, rounded to two decimals', () => {
  const result = build([day('a', 'google'), day('b', 'manual'), day('c', null)]);
  assert.deepEqual([result.totalSlots, result.googleSlots, result.otherSlots, result.unknownSlots, result.percentage], [3, 1, 1, 1, 33.33]);
  assert.equal(result.measurement, 'stored_busy_intervals');
  assert.equal(build([day('a', 'manual')]).percentage, 0);
});
test('no sample is null, empty days and invalid intervals never create slots', () => {
  assert.equal(build([]).percentage, null);
  assert.equal(build([day('a', 'google', []), day('b', 'google', [
    {start: -1, end: 10}, {start: 0, end: 1441}, {start: 5, end: 5}, {start: '5', end: 60}, null,
  ])]).totalSlots, 0);
  const invalid = day('a', 'google'); invalid.ref.path = 'availability/a/days/2030-02-30';
  assert.equal(build([invalid]).totalSlots, 0);
});
test('excludes unrelated collection groups and duplicate paths', () => {
  const d = day('a', 'google');
  assert.equal(build([d, d, slot('unrelated/a/slots/x', 'google'),
    slot('organizations/a/schedules/b/slots/x', 'google'),
    {ref: {path: 'unrelated/a/days/2030-11-13'}, data: d.data}]).totalSlots, 1);
});
test('day snapshots override mirrored slots including explicit empty days', () => {
  const privateSlot = slot('schedules/a/slots/private', 'google_calendar');
  const shared = slot('availability/a/slots/shared', undefined);
  assert.equal(build([day('a', 'google'), privateSlot, shared]).totalSlots, 1);
  assert.equal(build([day('a', 'google', []), privateSlot, shared]).totalSlots, 0);
  assert.equal(build([privateSlot, shared]).googleSlots, 1);
  assert.equal(build([shared]).unknownSlots, 1);
});
test('merges duplicates and overlaps; conflicting origins are explicitly unknown', () => {
  const first = slot('schedules/a/slots/one', 'google');
  const duplicate = slot('schedules/a/slots/two', 'google_calendar');
  assert.equal(build([first, duplicate]).googleSlots, 1);
  const other = slot('schedules/a/slots/three', 'manual', '2030-11-13T15:30:00Z');
  assert.equal(build([first, other]).unknownSlots, 1);
  assert.equal(build([first, other]).totalSlots, 1);
  const adjacent = slot('schedules/a/slots/adjacent', 'manual', '2030-11-13T16:00:00Z', '2030-11-13T17:00:00Z');
  assert.equal(build([first, adjacent]).otherSlots, 1);
  assert.equal(build([first, adjacent]).googleSlots, 1);
});
test('splits midnight-spanning intervals by Bogota day and rejects invalid dates', () => {
  const spanning = slot('schedules/a/slots/spanning', 'google', '2030-11-14T04:30:00Z', '2030-11-14T05:30:00Z');
  assert.equal(build([spanning]).googleSlots, 2);
  assert.equal(build([slot('schedules/a/slots/bad', 'google', 'invalid')]).totalSlots, 0);
});
test('refresh counts historical records, replacements, empty days and deletions without an index', async () => {
  const db = fakeDb([day('a', 'google'), day('b', 'manual')]);
  const now = new Date('2031-01-01T12:00:00Z');
  assert.equal((await refresh(db, {now})).percentage, 50);
  db.replace([day('a', 'google', [{start: 60, end: 120}, {start: 180, end: 240}])]);
  assert.equal((await refresh(db, {now})).googleSlots, 2);
  assert.equal((await refresh(db, {now})).googleSlots, 2);
  db.replace([day('a', 'google', [])]);
  assert.equal((await refresh(db, {now})).percentage, null);
  db.replace([]);
  await refresh(db, {now});
  assert.equal(db.written.size, 1);
  assert.equal(db.written.get(INSIGHT_PATH).updated_at, now);
});
test('aggregate never exposes identities, titles, descriptions, locations or interval times', async () => {
  const db = fakeDb([slot('schedules/SECRET_UID/slots/secret-event', 'google')]);
  const result = await refresh(db);
  assert.equal(result.googleSlots, 1);
  const serialized = JSON.stringify(result);
  for (const secret of ['SECRET_UID', 'secret-event', 'PRIVATE', '2030-11-13']) assert.ok(!serialized.includes(secret));
});
test('manual refresh requires organization claim, rejects paths and metrics before database access', async () => {
  const db = fakeDb([day('a', 'google')]), callable = createScheduleInsightCallable(db);
  await assert.rejects(callable.run({data: {}}), {code: 'unauthenticated'});
  await assert.rejects(callable.run({auth: {uid: 'user', token: {}}, data: {}}), {code: 'permission-denied'});
  const auth = {uid: 'analyst', token: {orgAnalytics: true}};
  for (const data of [{path: 'schedules'}, {googleSlots: 100}, [], 'path']) {
    await assert.rejects(callable.run({auth, data}), {code: 'invalid-argument'});
  }
  assert.equal(db.written.size, 0);
  assert.equal((await callable.run({auth, data: {}})).googleSlots, 1);
});
test('Gabriel card renders counts, unknowns, doughnut, empty state and preserves numeric sorting', async () => {
  const {createScheduleImportQuestion} = await import('../../dashboard/schedule-question.mjs');
  const {compareQuestionIds, createActivityQuestions} = await import('../../dashboard/activity-questions.mjs');
  const q = createScheduleImportQuestion();
  const result = build([day('a', 'google'), day('b', 'manual'), day('c', null)]);
  const view = q.render(result);
  assert.equal(q.owner, 'Gabriel Polania');
  assert.equal(q.doc, 'bq9_google_calendar_adoption');
  assert.equal(view.number, '33.33%');
  assert.deepEqual(view.stats.map(s => s.value), [3, 1, 1, 1]);
  assert.deepEqual(view.chart.datasets[0].data, [1, 1, 1]);
  assert.equal(view.chartType, 'doughnut');
  assert.match(view.method, /not an individual Google event/);
  assert.equal(q.hasData(build([])), false);
  assert.ok(q.empty.length > 20);
  const existing = createActivityQuestions({reminderLabel: s => s});
  assert.deepEqual(existing.map(q => q.id), ['bq2', 'bq3', 'bq13', 'bq14']);
  assert.deepEqual(['bq13', 'bq9-google', 'bq11', 'bq9', 'bq2'].map(id => ({id})).sort(compareQuestionIds)
      .map(q => q.id), ['bq2', 'bq9', 'bq9-google', 'bq11', 'bq13']);
});
test('existing dashboard loads the new card and refresh callable without replacing team refresh', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(`${__dirname}/../../dashboard/index.html`, 'utf8');
  for (const text of ['createScheduleImportQuestion(),', '"refreshScheduleImportInsight"',
    '"refreshTeamInsights"', '"refreshActivityInsights"', 'view.chartType || "bar"',
    'getDoc(doc(db, "insights", q.doc))']) assert.ok(html.includes(text));
  const index = fs.readFileSync(`${__dirname}/../index.js`, 'utf8');
  assert.match(index, /exports.refreshScheduleImportInsightNightly = onSchedule\(/);
  assert.match(index, /schedule: 'every day 05:00', timeZone: 'America\/Bogota', region: 'us-central1'/);
});
