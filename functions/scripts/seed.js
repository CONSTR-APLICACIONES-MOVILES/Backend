/**
   Writes the demo groups to Firestore.
  
     npm run seed -- --project <firebase-project-id>            creates missing groups only
     npm run seed -- --project <firebase-project-id> --force    also resets existing groups, which
                                                                removes accounts that joined on sign-up
 
   Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
   Against a real project: run `gcloud auth application-default login` once.
 */
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {demoGroups, demoAvailability} = require("../src/demoData");
const {localDate} = require("../src/availability");

/* Days of demo availability written for the Schedule screen (today onward). */
const AVAILABILITY_DAYS = 14;

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

  // Demo members have no Google Calendar, so give them dated snapshots like an import would.
  const docs = demoAvailability(localDate(new Date()), AVAILABILITY_DAYS);
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + 400)) {
      batch.set(db.doc(`availability/${doc.uid}/days/${doc.date}`),
          {date: doc.date, busy: doc.busy, source: "demo", updatedAt: FieldValue.serverTimestamp()});
    }
    await batch.commit();
  }
  console.log(`wrote  ${docs.length} demo availability days`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
