/**
   Writes the demo groups to Firestore.
  
     npm run seed -- --project <firebase-project-id>            creates missing groups only
     npm run seed -- --project <firebase-project-id> --force    also resets existing groups, which
                                                                removes accounts that joined on sign-up
 
   Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
   Against a real project: run `gcloud auth application-default login` once.
 */
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {demoGroups} = require("../src/demoData");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const projectId = argValue("--project") || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Pass --project <firebase-project-id>");
  }
  const force = process.argv.includes("--force");
  initializeApp({projectId});
  const db = getFirestore();

  for (const [groupId, data] of Object.entries(demoGroups())) {
    const ref = db.collection("groups").doc(groupId);
    if (!force && (await ref.get()).exists) {
      console.log(`skip   groups/${groupId} (exists, use --force to reset)`);
      continue;
    }
    await ref.set(data);
    console.log(`wrote  groups/${groupId} (${data.members.length} members)`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
