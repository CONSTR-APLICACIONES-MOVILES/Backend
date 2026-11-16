const test = require("node:test");
const assert = require("node:assert/strict");
const {demoGroups, memberForAccount, DEMO_USER_ID} = require("../src/demoData");

test("has the same groups and sizes as DemoData.java", () => {
  const groups = demoGroups();
  const sizes = Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, g.members.length]));
  assert.deepEqual(sizes, {roomies: 4, eng: 8, intramurals: 6, thesis: 5, choir: 12});
  assert.deepEqual(groups.intramurals.goingIds, ["intramurals_m1", "intramurals_m2", "intramurals_m3"]);
});

test("matches the Roomies schedule in DemoData.java", () => {
  const mateo = demoGroups().roomies.members.find((m) => m.id === "mateo");
  assert.deepEqual(mateo, {
    id: "mateo",
    name: "Mateo",
    initials: "M",
    preferredStart: 19 * 60,
    preferredEnd: 22 * 60,
    busy: [{start: 540, end: 780}, {start: 1080, end: 1170}],
  });
});

test("memberIds lists every member, including the demo user", () => {
  for (const group of Object.values(demoGroups())) {
    assert.deepEqual(group.memberIds, group.members.map((m) => m.id));
    assert.ok(group.memberIds.includes(DEMO_USER_ID));
  }
});

test("builds the member name from the email like UserProfile.fromAccount", () => {
  const member = memberForAccount("uid123", "maria.lopez@uni.edu", null);
  assert.equal(member.name, "Maria Lopez");
  assert.equal(member.initials, "ML");
  assert.deepEqual(member.busy, []);
  assert.equal(memberForAccount("u", "x@y.co", "Juan David Guzmán").initials, "JG");
});

test("demo availability: weekdays shift the schedule, weekends are free", () => {
  const {demoBusyOn, demoAvailability} = require("../src/demoData");
  const mateo = demoGroups().roomies.members.find((m) => m.id === "mateo");
  assert.deepEqual(demoBusyOn(mateo, "2026-10-26"), mateo.busy); // Monday, no shift
  assert.deepEqual(demoBusyOn(mateo, "2026-10-27"), [{start: 570, end: 810}, {start: 1110, end: 1200}]);
  assert.deepEqual(demoBusyOn(mateo, "2026-10-31"), []); // Saturday
  const docs = demoAvailability("2026-10-26", 2);
  assert.ok(docs.some((d) => d.uid === "mateo" && d.date === "2026-10-27"));
  assert.ok(docs.every((d) => d.busy.every((b) => b.start < b.end && b.end <= 1440)));
});

test("campus areas use the locationAreaId values publishActivity accepts", () => {
  const {CAMPUS_AREAS} = require("../src/campusAreas");
  const accepted = ["central_library", "mario_laserna", "campus_north", "campus_south", "outside_campus", "unknown"];
  for (const area of CAMPUS_AREAS) {
    assert.ok(accepted.includes(area.id), area.id);
    assert.ok(area.name && Array.isArray(area.aliases));
    if (area.id !== "outside_campus") assert.ok(Number.isFinite(area.lat) && Number.isFinite(area.lng));
  }
});
