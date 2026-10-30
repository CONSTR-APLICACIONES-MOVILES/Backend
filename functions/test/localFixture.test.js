const test = require("node:test");
const assert = require("node:assert/strict");
const {joinDemoGroups} = require("../src/groupMembership");

test("production signups never read or write demo memberships", async () => {
  const db = new Proxy({}, {get() { throw new Error('Production signup must not access group data'); }});
  for (const uid of ['ordinary-user', 'local-test-alex-valenzuela']) {
    const joined = await joinDemoGroups(db, {uid}, {emulator: false});
    assert.equal(joined, false);
  }
});

test("local fixture identities bypass legacy emulator sample memberships", async () => {
  let transactions = 0;
  const db = {runTransaction: async () => { transactions++; }};
  const user = {uid: "local-test-alex-valenzuela", email: "a.va@test.com"};
  await joinDemoGroups(db, user, {emulator: true});
  assert.equal(transactions, 0);
  await joinDemoGroups(db, user, {emulator: false});
  assert.equal(transactions, 0);
  await joinDemoGroups(db, {...user, uid: "ordinary-user"}, {emulator: true});
  assert.equal(transactions, 1);
});
