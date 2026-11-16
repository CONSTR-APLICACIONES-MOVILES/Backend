const {demoGroups, memberForAccount} = require("./demoData");

async function joinDemoGroups(db, user, {emulator = process.env.FUNCTIONS_EMULATOR === "true"} = {}) {
  // Production accounts start empty. Joining a group requires an explicit action.
  // Keep legacy sample onboarding exclusively in the local emulator.
  if (!emulator) return false;
  // Local test identities get exactly the two real-peer groups from seed:testing.
  // This bypass is never applied to production or ordinary account creation.
  if (emulator && user.uid.startsWith("local-test-")) return;
  const samples = demoGroups();
  const ids = Object.keys(samples);
  const member = memberForAccount(user.uid, user.email, user.displayName);
  await db.runTransaction(async (tx) => {
    const groups = await tx.getAll(...ids.map((id) => db.doc(`groups/${id}`)));
    for (const [index, group] of groups.entries()) {
      const data = group.data() || samples[ids[index]];
      if (data.memberIds.includes(user.uid)) {
        if (!group.exists) tx.set(group.ref, data);
        continue;
      }
      const membership = {members: [...data.members, member], memberIds: [...data.memberIds, user.uid]};
      if (group.exists) tx.update(group.ref, membership);
      else tx.set(group.ref, {...data, ...membership});
    }
  });
  return true;
}
module.exports = {joinDemoGroups};
