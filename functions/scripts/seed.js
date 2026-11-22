
/**
 * ParchApp — Firebase Firestore Demo Seed
 *
 * Supports:
 * - Groups
 * - Users
 * - Friendships
 * - Locations
 * - Private schedules
 * - Schedule slots
 * - Shared availability
 * - Andes Events
 *
 * FULL DEMO SEED:
 *
 * node scripts/seed.js \
 *   --project parchapp-ee6cc \
 *   --user FIREBASE_AUTH_UID
 *
 * ANDES EVENTS ONLY:
 *
 * node scripts/seed.js \
 *   --project parchapp-ee6cc \
 *   --andes-events-only
 *
 * UPDATE EXISTING ANDES EVENTS:
 *
 * node scripts/seed.js \
 *   --project parchapp-ee6cc \
 *   --andes-events-only \
 *   --force
 *
 * IMPORTANT:
 * Never run the full demo seed against production
 * unless you explicitly intend to modify demo users,
 * groups, schedules and availability.
 *
 * Andes Events are fictional development examples.
 */

"use strict";

// ================================================================
// FIREBASE ADMIN
// ================================================================

const {
  initializeApp,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

// ================================================================
// EXISTING PARCHAPP DEMO DATA
// ================================================================

const {
  DEFAULT_DEMO_USER_ID,

  demoGroups,
  demoUsers,
  demoFriendships,
  demoLocations,

  demoSchedules,
  demoScheduleSlots,

  demoAvailability,
  demoAvailabilitySlots,
} = require("../src/demoData");

const {
  localDate,
} = require("../src/availability");

const {
  CAMPUS_AREAS,
} = require("../src/campusAreas");

const AVAILABILITY_DAYS = 14;

// ================================================================
// ARGUMENT HELPERS
// ================================================================

function argValue(name) {
  const index = process.argv.indexOf(name);

  if (index < 0) {
    return undefined;
  }

  return process.argv[index + 1];
}

// ================================================================
// GENERIC DOCUMENT WRITE
// ================================================================

async function writeDocument(
  ref,
  data,
  force,
  label
) {
  const snapshot = await ref.get();

  if (!force && snapshot.exists) {
    console.log(
      `skip   ${label} (exists, use --force to reset)`
    );

    return false;
  }

  await ref.set(data);

  console.log(`wrote  ${label}`);

  return true;
}

// ================================================================
// GROUPS
// ================================================================

async function seedGroups(db, force) {
  console.log("");
  console.log("=== GROUPS ===");

  const groups = demoGroups();

  for (const [groupId, data] of Object.entries(groups)) {
    const ref = db
      .collection("groups")
      .doc(groupId);

    const snapshot = await ref.get();

    if (!force && snapshot.exists) {
      console.log(
        `skip   groups/${groupId} ` +
        "(exists, use --force to reset)"
      );

      continue;
    }

    await ref.set(data);

    console.log(
      `wrote  groups/${groupId} ` +
      `(${data.members.length} members)`
    );
  }

  // Campus areas are shared reference data.
  // Preserve the existing behavior of rewriting them.

  const areasBatch = db.batch();

  for (const { id, ...area } of CAMPUS_AREAS) {
    areasBatch.set(
      db.doc(`campusAreas/${id}`),
      area
    );
  }

  await areasBatch.commit();

  console.log(
    `wrote  ${CAMPUS_AREAS.length} campus areas`
  );

  // Demo availability snapshots for group members.

  const docs = demoAvailability(
    localDate(new Date()),
    AVAILABILITY_DAYS
  );

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();

    for (const doc of docs.slice(i, i + 400)) {
      batch.set(
        db.doc(
          `availability/${doc.uid}/days/${doc.date}`
        ),
        {
          date: doc.date,
          busy: doc.busy,
          source: "demo",
          updatedAt: FieldValue.serverTimestamp(),
        }
      );
    }

    await batch.commit();
  }

  console.log(
    `wrote  ${docs.length} demo availability days`
  );
}

// ================================================================
// USERS
// ================================================================

async function seedUsers(
  db,
  force,
  mainUserId
) {
  console.log("");
  console.log("=== USERS ===");

  const users = demoUsers(mainUserId);

  for (const [userId, data] of Object.entries(users)) {
    const ref = db
      .collection("users")
      .doc(userId);

    await writeDocument(
      ref,
      data,
      force,
      `users/${userId}`
    );
  }
}

// ================================================================
// FRIENDSHIPS
// ================================================================

async function seedFriendships(
  db,
  force,
  mainUserId
) {
  console.log("");
  console.log("=== FRIENDSHIPS ===");

  const friendships = demoFriendships(mainUserId);

  for (
    const [ownerId, friends]
    of Object.entries(friendships)
  ) {
    for (
      const [friendId, data]
      of Object.entries(friends)
    ) {
      const ref = db
        .collection("users")
        .doc(ownerId)
        .collection("friends")
        .doc(friendId);

      await writeDocument(
        ref,
        data,
        force,
        `users/${ownerId}/friends/${friendId}`
      );
    }
  }
}

// ================================================================
// LOCATIONS
// ================================================================

async function seedLocations(db, force) {
  console.log("");
  console.log("=== LOCATIONS ===");

  const locations = demoLocations();

  for (
    const [userId, data]
    of Object.entries(locations)
  ) {
    const ref = db
      .collection("locations")
      .doc(userId);

    await writeDocument(
      ref,
      data,
      force,
      `locations/${userId}`
    );
  }
}

// ================================================================
// PRIVATE SCHEDULE PARENTS
// ================================================================

async function seedSchedules(db, force) {
  console.log("");
  console.log("=== PRIVATE SCHEDULES ===");

  const schedules = demoSchedules();

  for (
    const [userId, data]
    of Object.entries(schedules)
  ) {
    const ref = db
      .collection("schedules")
      .doc(userId);

    await writeDocument(
      ref,
      data,
      force,
      `schedules/${userId}`
    );
  }
}

// ================================================================
// PRIVATE SCHEDULE SLOTS
// ================================================================

async function seedScheduleSlots(db, force) {
  console.log("");
  console.log("=== PRIVATE SCHEDULE SLOTS ===");

  const schedules = demoScheduleSlots();

  for (
    const [userId, slots]
    of Object.entries(schedules)
  ) {
    for (
      const [slotId, data]
      of Object.entries(slots)
    ) {
      const ref = db
        .collection("schedules")
        .doc(userId)
        .collection("slots")
        .doc(slotId);

      await writeDocument(
        ref,
        data,
        force,
        `schedules/${userId}/slots/${slotId}`
      );
    }
  }
}

// ================================================================
// SHARED AVAILABILITY PARENTS
// ================================================================

async function seedAvailability(db, force) {
  console.log("");
  console.log("=== SHARED AVAILABILITY ===");

  const availability = demoAvailability();

  for (
    const [userId, data]
    of Object.entries(availability)
  ) {
    const ref = db
      .collection("availability")
      .doc(userId);

    await writeDocument(
      ref,
      data,
      force,
      `availability/${userId}`
    );
  }
}

// ================================================================
// SHARED AVAILABILITY SLOTS
// ================================================================

async function seedAvailabilitySlots(
  db,
  force
) {
  console.log("");
  console.log("=== SHARED AVAILABILITY SLOTS ===");

  const availability = demoAvailabilitySlots();

  for (
    const [userId, slots]
    of Object.entries(availability)
  ) {
    for (
      const [slotId, data]
      of Object.entries(slots)
    ) {
      const ref = db
        .collection("availability")
        .doc(userId)
        .collection("slots")
        .doc(slotId);

      await writeDocument(
        ref,
        data,
        force,
        `availability/${userId}/slots/${slotId}`
      );
    }
  }
}

// ================================================================
// ANDES EVENTS — DEVELOPMENT DATA
// ================================================================

function demoAndesEvents() {
  // All events are fictional.
  // Times use Bogota's UTC-05:00 offset.

  const events = [
    {
      id: "demo-andes-ai-workshop-2026",
      title: "AI & Innovation Workshop",
      description:
        "A hands-on session exploring artificial " +
        "intelligence and creative problem solving.",
      category: "Academic",
      location:
        "Building ML, Universidad de los Andes",
      start: "2026-12-02T14:00:00-05:00",
      end: "2026-12-02T16:00:00-05:00",
    },
    {
      id: "demo-andes-cultural-afternoon-2026",
      title: "Campus Cultural Afternoon",
      description:
        "A student gathering to explore cultural " +
        "expression and campus traditions.",
      category: "Cultural",
      location:
        "Main Campus, Universidad de los Andes",
      start: "2026-12-04T15:00:00-05:00",
      end: "2026-12-04T17:00:00-05:00",
    },
    {
      id: "demo-andes-sports-challenge-2026",
      title: "University Sports Challenge",
      description:
        "A friendly sports session designed " +
        "for students of all skill levels.",
      category: "Sports",
      location:
        "Sports Center, Universidad de los Andes",
      start: "2026-12-07T09:00:00-05:00",
      end: "2026-12-07T11:00:00-05:00",
    },
    {
      id: "demo-andes-entrepreneurship-2026",
      title: "Entrepreneurship Talk",
      description:
        "A discussion about turning university " +
        "ideas into practical ventures.",
      category: "Academic",
      location:
        "Building SD, Universidad de los Andes",
      start: "2026-12-09T10:00:00-05:00",
      end: "2026-12-09T12:00:00-05:00",
    },
    {
      id: "demo-andes-music-arts-2026",
      title: "Music and Arts Gathering",
      description:
        "An afternoon of music, art, " +
        "and conversation on campus.",
      category: "Cultural",
      location:
        "Main Campus, Universidad de los Andes",
      start: "2026-12-11T16:00:00-05:00",
      end: "2026-12-11T18:00:00-05:00",
    },
    {
      id: "demo-andes-networking-2026",
      title: "Student Networking Meetup",
      description:
        "Meet students from different programs " +
        "and exchange ideas.",
      category: "Other",
      location:
        "Building AU, Universidad de los Andes",
      start: "2026-12-15T14:00:00-05:00",
      end: "2026-12-15T15:30:00-05:00",
    },
  ];

  return events.map(
    ({ id, start, end, ...fields }) => ({
      id,
      data: {
        ...fields,

        start: Timestamp.fromDate(
          new Date(start)
        ),

        end: Timestamp.fromDate(
          new Date(end)
        ),

        published: true,
        isDemo: true,
        sourceUrl: null,
      },
    })
  );
}

// ================================================================
// SEED ANDES EVENTS
// ================================================================

async function seedAndesEvents(db, force) {
  console.log("");
  console.log("========================================");
  console.log("=== ANDES EVENTS ===");
  console.log("========================================");

  const events = demoAndesEvents();

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const { id, data } of events) {
    const ref = db
      .collection("andesEvents")
      .doc(id);

    const snapshot = await ref.get();

    if (snapshot.exists && !force) {
      console.log(
        `skip   andesEvents/${id} (already exists)`
      );

      skipped++;
      continue;
    }

    await ref.set(data);

    if (snapshot.exists) {
      updated++;

      console.log(
        `updated andesEvents/${id}`
      );
    } else {
      created++;

      console.log(
        `created andesEvents/${id}`
      );
    }
  }

  console.log("");
  console.log("Andes Events summary:");
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total:   ${events.length}`);
}

// ================================================================
// MAIN
// ================================================================

async function main() {
  const projectId =
    argValue("--project") ||
    process.env.GCLOUD_PROJECT;

  if (!projectId) {
    throw new Error(
      "Pass --project <firebase-project-id>"
    );
  }

  const mainUserId =
    argValue("--user") ||
    DEFAULT_DEMO_USER_ID;

  const force = process.argv.includes(
    "--force"
  );

  const andesOnly = process.argv.includes(
    "--andes-events-only"
  );

  console.log("");
  console.log("========================================");
  console.log("ParchApp Demo Seed");
  console.log("========================================");

  console.log(`Project: ${projectId}`);
  console.log(`Main user: ${mainUserId}`);
  console.log(
    `Force reset: ${force ? "YES" : "NO"}`
  );

  console.log(
    "Firestore target: " +
    (
      process.env.FIRESTORE_EMULATOR_HOST ||
      "REAL FIRESTORE"
    )
  );

  // Initialize Firebase Admin.

  initializeApp({
    projectId,
  });

  const db = getFirestore();

  // ============================================================
  // ANDES EVENTS ONLY
  // ============================================================

  if (andesOnly) {
    console.log("");
    console.log(
      "Andes Events only mode enabled."
    );

    console.log(
      "Groups, users, friendships, and schedules " +
      "will not be modified."
    );

    await seedAndesEvents(db, force);

    console.log("");
    console.log(
      "Andes Events seed completed."
    );

    return;
  }

  // ============================================================
  // FULL DEMO SEED
  // ============================================================

  // Safety: do not run the full demo seed against
  // the official production project by accident.

  if (
    projectId === "parchapp-ee6cc" &&
    !process.env.FIRESTORE_EMULATOR_HOST
  ) {
    throw new Error(
      "Full demo seeding is blocked on the official " +
      "Firestore project. Use --andes-events-only " +
      "to publish the university event examples."
    );
  }

  // ------------------------------------------------------------
  // GROUPS
  // ------------------------------------------------------------

  await seedGroups(
    db,
    force
  );

  // ------------------------------------------------------------
  // USERS AND FRIENDSHIPS
  // ------------------------------------------------------------

  await seedUsers(
    db,
    force,
    mainUserId
  );

  await seedFriendships(
    db,
    force,
    mainUserId
  );

  // ------------------------------------------------------------
  // LOCATIONS
  // ------------------------------------------------------------

  await seedLocations(
    db,
    force
  );

  // ------------------------------------------------------------
  // PRIVATE SCHEDULES
  // ------------------------------------------------------------

  await seedSchedules(
    db,
    force
  );

  await seedScheduleSlots(
    db,
    force
  );

  // ------------------------------------------------------------
  // SHARED AVAILABILITY
  // ------------------------------------------------------------

  await seedAvailability(
    db,
    force
  );

  await seedAvailabilitySlots(
    db,
    force
  );

  // ------------------------------------------------------------
  // ANDES EVENTS
  // ------------------------------------------------------------

  await seedAndesEvents(
    db,
    force
  );

  console.log("");
  console.log("========================================");
  console.log("Demo seed completed.");
  console.log(
    `Friends generated for user: ${mainUserId}`
  );
  console.log("========================================");
}

// ================================================================
// ERROR HANDLING
// ================================================================

main().catch((error) => {
  console.error("");
  console.error("Seed failed:");

  console.error(
    error.stack ||
    error.message ||
    error
  );

  process.exitCode = 1;
});
