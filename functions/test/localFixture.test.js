const test = require("node:test");
const assert = require("node:assert/strict");
const {joinDemoGroups} = require("../src/groupMembership");

test("only emulator fixture identities bypass automatic demo memberships", async () => {
  let transactions = 0;
  const db = {runTransaction: async () => { transactions++; }};
  const user = {uid: "local-test-alex-valenzuela", email: "a.va@test.com"};
  await joinDemoGroups(db, user, {emulator: true});
  assert.equal(transactions, 0);
  await joinDemoGroups(db, user, {emulator: false});
  assert.equal(transactions, 1);
  await joinDemoGroups(db, {...user, uid: "ordinary-user"}, {emulator: true});
  assert.equal(transactions, 2);
});
