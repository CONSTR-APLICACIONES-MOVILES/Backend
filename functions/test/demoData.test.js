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
