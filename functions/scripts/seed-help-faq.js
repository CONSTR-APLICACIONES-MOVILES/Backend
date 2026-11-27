/**
   Loads the help questions of the Java app into helpFaq/{id}, from the same help_faq.json that the app carries
   inside, so the copy in the app and the one in Firestore are the same.

     npm run seed-help -- --project <firebase-project-id>
     npm run seed-help -- --project <firebase-project-id> --file path/to/help_faq.json

   Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
   Against a real project: run `gcloud auth application-default login` once.
 */
const fs = require("node:fs");
const path = require("node:path");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

const DEFAULT_FILE = path.join(__dirname, "../../../SPRINT-3-JAVA/app/src/main/res/raw/help_faq.json");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const projectId = argValue("--project") || process.env.GCLOUD_PROJECT;
  if (!projectId) throw new Error("Pass --project <firebase-project-id>");
  const file = argValue("--file") || DEFAULT_FILE;
  const questions = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(questions) || questions.length === 0) throw new Error(`No questions in ${file}`);

  initializeApp({projectId});
  const db = getFirestore();
  const batch = db.batch();
  const ids = new Set();
  for (const q of questions) {
    for (const field of ["id", "screen", "question", "answer"]) {
      if (typeof q[field] !== "string" || !q[field]) throw new Error(`Question without ${field}: ${JSON.stringify(q)}`);
    }
    if (ids.has(q.id)) throw new Error(`Repeated id ${q.id}`);
    ids.add(q.id);
    // active: true is what the app asks for; a question can be hidden later by setting it to false
    batch.set(db.doc(`helpFaq/${q.id}`), {
      screen: q.screen, question: q.question, answer: q.answer, position: Number(q.position) || 0, active: true,
    });
  }
  await batch.commit();
  console.log(`wrote  ${questions.length} questions to helpFaq (${projectId})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
