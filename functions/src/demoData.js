/**
 * Demo data for the ParchApp prototype.
 *
 * This file contains deterministic demo data used by the backend seed.
 *
 * Group availability keeps the legacy minutes-since-midnight format.
 *
 * Schedule uses:
 *
 *   users/{uid}
 *   users/{uid}/friends/{friendUid}
 *   locations/{uid}
 *   schedules/{uid}/slots/{slotId}
 *   availability/{uid}/slots/{slotId}
 */

const {
  GeoPoint,
} = require("firebase-admin/firestore");


// ======================================================================
// DEFAULT MAIN USER
// ======================================================================

/**
 * Fallback demo user.
 *
 * The seed can override this using:
 *
 *   --user <firebase-auth-uid>
 *
 * Example:
 *
 *   --user eLVNNfXBNzeyH6fnStVSAzpYyNmk
 */
const DEFAULT_DEMO_USER_ID = "Rj638OJ1qmz5Y2wdiUegDP5o36tc";


// ======================================================================
// DEMO FRIENDS
// ======================================================================

const DEMO_FRIEND_IDS = [
  "mateo",
  "camila",
  "lucas",
  "sofia",
];


// ======================================================================
// DUMMY LOCATION ORIGIN
// ======================================================================

/**
 * Reference point for dummy friend locations.
 *
 * Later, if needed, this can be moved closer to the real demonstration area.
 */
const DEMO_LOCATION_ORIGIN = {
  latitude: 4.6410,
  longitude: -74.0615,
};


// ======================================================================
// COMMON HELPERS
// ======================================================================

function initialsFromName(name) {
  const words = name
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);

  if (words.length === 0) {
    return "?";
  }

  if (words.length === 1) {
    return words[0][0].toUpperCase();
  }

  return (
    words[0][0] +
    words[words.length - 1][0]
  ).toUpperCase();
}


/**
 * Builds a local Colombia date.
 *
 * Colombia is UTC-5.
 */
function localDate(
    dayKey,
    hour,
    minute = 0,
) {
  const hh =
    String(hour).padStart(2, "0");

  const mm =
    String(minute).padStart(2, "0");

  return new Date(
      `${dayKey}T${hh}:${mm}:00-05:00`,
  );
}


/**
 * Creates one private schedule slot.
 */
function scheduleSlot(
    userId,
    slotId,
    dayKey,
    startHour,
    startMinute,
    endHour,
    endMinute,
    title,
    description = "",
    location = "",
) {
  const data = {
    externalId: `${userId}-${slotId}`,
    title,

    start: localDate(
        dayKey,
        startHour,
        startMinute,
    ),

    end: localDate(
        dayKey,
        endHour,
        endMinute,
    ),

    dayKey,
    source: "google_calendar",
    importedAt: new Date(),
  };

  if (description) {
    data.description = description;
  }

  if (location) {
    data.location = location;
  }

  return data;
}


/**
 * Privacy-safe representation of a private schedule slot.
 */
function availabilitySlot(slot) {
  return {
    start: slot.start,
    end: slot.end,
    dayKey: slot.dayKey,
  };
}


// ======================================================================
// LEGACY GROUP HELPERS
// ======================================================================

function member(
    id,
    name,
    preferredStartHour,
    preferredEndHour,
    ...busyHours
) {
  const busy = [];

  for (
    let i = 0;
    i + 1 < busyHours.length;
    i += 2
  ) {
    busy.push({
      start:
        Math.trunc(
            busyHours[i] * 60,
        ),

      end:
        Math.trunc(
            busyHours[i + 1] * 60,
        ),
    });
  }

  return {
    id,
    name,
    initials: name.substring(0, 1),
    preferredStart:
      preferredStartHour * 60,
    preferredEnd:
      preferredEndHour * 60,
    busy,
  };
}


function group(
    name,
    icon,
    planTitle,
    members,
    goingIds,
) {
  return {
    name,
    icon,
    planTitle,
    members,

    memberIds:
      members.map(
          (m) => m.id,
      ),

    goingIds,
    maybeIds: [],
    pendingInvites: [],
  };
}


// ======================================================================
// GROUPS
// ======================================================================

function roomies() {
  const members = [
    member(
        DEFAULT_DEMO_USER_ID,
        "Alex",
        18,
        21,
        8,
        12,
        14,
        16,
    ),

    member(
        "mateo",
        "Mateo",
        19,
        22,
        9,
        13,
        18,
        19.5,
    ),

    member(
        "camila",
        "Camila",
        17,
        20,
        10,
        17,
    ),

    member(
        "lucas",
        "Lucas",
        20,
        23,
        8,
        10,
        13,
        18,
    ),
  ];

  return group(
      "Roomies Main St",
      "⌂",
      "Weekly House Dinner & Grocery Run",
      members,
      [
        DEFAULT_DEMO_USER_ID,
        "mateo",
        "camila",
        "lucas",
      ],
  );
}


function generated(
    id,
    name,
    icon,
    planTitle,
    size,
    going,
) {
  const members = [
    member(
        DEFAULT_DEMO_USER_ID,
        "Alex",
        18,
        21,
        8,
        12,
        14,
        16,
    ),
  ];

  const goingIds = [];

  for (
    let i = 1;
    i < size;
    i++
  ) {
    const classStart =
      8 + (i % 4);

    const classEnd =
      classStart +
      2 +
      (i % 3);

    const afternoonStart =
      14 + (i % 3);

    const memberId =
      `${id}_m${i}`;

    members.push(
        member(
            memberId,
            `Member ${i}`,
            17 + (i % 3),
            21 + (i % 2),
            classStart,
            classEnd,
            afternoonStart,
            afternoonStart + 1.5,
        ),
    );

    if (
      goingIds.length <
      going
    ) {
      goingIds.push(
          memberId,
      );
    }
  }

  return group(
      name,
      icon,
      planTitle,
      members,
      goingIds,
  );
}


function demoGroups() {
  return {
    roomies:
      roomies(),

    eng:
      generated(
          "eng",
          "Engineering 2026",
          "🎓",
          "Linear Algebra midterm study",
          8,
          3,
      ),

    intramurals:
      generated(
          "intramurals",
          "Campus Intramurals",
          "⚽",
          "5-a-side Soccer & Social",
          6,
          3,
      ),

    thesis:
      generated(
          "thesis",
          "Thesis Support Group",
          "📌",
          "",
          5,
          0,
      ),

    choir:
      generated(
          "choir",
          "University Choir",
          "🎵",
          "Rehearsal",
          12,
          7,
      ),
  };
}


// ======================================================================
// USER PROFILES
// ======================================================================

function userProfile(name) {
  return {
    name:
      name.split(/\s+/)[0],

    fullName:
      name,

    initials:
      initialsFromName(name),
  };
}

/*
  Busy blocks of a demo member on a given date (YYYY-MM-DD). Weekdays reuse the member's
  schedule shifted by 0, 30 or 60 minutes so each day looks different; weekends are free.
  Port of DemoData.busyOn in the Android app: keep both in sync.
 */
function demoBusyOn(member, date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  if (weekday === 0 || weekday === 6) {
    return [];
  }
  const shift = ((weekday - 1) % 3) * 30;
  return member.busy
      .map((b) => ({start: Math.min(1440, b.start + shift), end: Math.min(1440, b.end + shift)}))
      .filter((b) => b.start < b.end);
}

/* availability/{uid}/days/{date} documents for every demo member, starting at startDate. */
function demoDailyAvailability(startDate, days) {
  const members = new Map();
  for (const group of Object.values(demoGroups())) {
    for (const member of group.members) {
      members.set(member.id, member);
    }
  }
  const start = Date.parse(`${startDate}T12:00:00Z`);
  const docs = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    for (const member of members.values()) {
      docs.push({uid: member.id, date, busy: demoBusyOn(member, date)});
    }
  }
  return docs;
}


/**
 * Demo users.
 *
 * mainUserId is passed by the seed.
 */
function demoUsers(
    mainUserId =
      DEFAULT_DEMO_USER_ID,
) {
  return {
    [mainUserId]:
      userProfile(
          "Gabriel Polania",
      ),

    mateo:
      userProfile(
          "Mateo Rodriguez",
      ),

    camila:
      userProfile(
          "Camila Torres",
      ),

    lucas:
      userProfile(
          "Lucas Martinez",
      ),

    sofia:
      userProfile(
          "Sofia Ramirez",
      ),
  };
}


// ======================================================================
// FRIENDSHIPS
// ======================================================================

function friendship(friendId) {
  return {
    friendId,
    status: "accepted",
    createdAt: new Date(),
  };
}


/**
 * Generates friendships for whichever user ID is passed.
 *
 * Example:
 *
 * mainUserId =
 * eLVNNfXBNzeyH6fnStVSAzpYyNmk
 *
 * creates:
 *
 * users/eLV.../friends/mateo
 * users/eLV.../friends/camila
 * users/eLV.../friends/lucas
 * users/eLV.../friends/sofia
 *
 * and reverse relations.
 */
function demoFriendships(
    mainUserId =
      DEFAULT_DEMO_USER_ID,
) {
  const friendships = {
    [mainUserId]: {},
  };

  for (
    const friendId
    of DEMO_FRIEND_IDS
  ) {
    friendships[
        mainUserId
    ][
        friendId
    ] =
      friendship(
          friendId,
      );

    friendships[
        friendId
    ] = {
      [mainUserId]:
        friendship(
            mainUserId,
        ),
    };
  }

  return friendships;
}


// ======================================================================
// LOCATIONS
// ======================================================================

function demoLocations() {
  const lat =
    DEMO_LOCATION_ORIGIN.latitude;

  const lng =
    DEMO_LOCATION_ORIGIN.longitude;

  return {
    // ---------------------------------------------------------------
    // Mateo: muy cerca del punto de referencia
    // ~250-300 m
    // ---------------------------------------------------------------
    mateo: {
      location:
        new GeoPoint(
          lat + 0.0020,
          lng + 0.0015,
        ),

      updatedAt:
        new Date(),
    },

    // ---------------------------------------------------------------
    // Camila: cerca
    // ~700 m
    // ---------------------------------------------------------------
    camila: {
      location:
        new GeoPoint(
          lat - 0.0050,
          lng + 0.0040,
        ),

      updatedAt:
        new Date(),
    },

    // ---------------------------------------------------------------
    // Lucas: más lejos pero todavía dentro de 2 km
    // ~1.4 km
    // ---------------------------------------------------------------
    lucas: {
      location:
        new GeoPoint(
          lat + 0.0100,
          lng - 0.0080,
        ),

      updatedAt:
        new Date(),
    },

    // ---------------------------------------------------------------
    // Sofia: deliberadamente lejos
    // ~8 km
    //
    // Sirve para demostrar que el filtro de Nearby Friends funciona.
    // ---------------------------------------------------------------
    sofia: {
      location:
        new GeoPoint(
          lat + 0.0600,
          lng + 0.0400,
        ),

      updatedAt:
        new Date(),
    },
  };
}

// ======================================================================
// PRIVATE FRIEND SCHEDULES
// ======================================================================

function demoScheduleSlots() {
  return {
    mateo: {
      "mateo-slot-001":
        scheduleSlot(
            "mateo",
            "slot-001",
            "2026-10-09",
            8,
            30,
            10,
            0,
            "Algorithms class",
            "Algorithms lecture",
            "Engineering Building",
        ),

      "mateo-slot-002":
        scheduleSlot(
            "mateo",
            "slot-002",
            "2026-10-09",
            13,
            0,
            14,
            30,
            "Project meeting",
            "Sprint meeting",
            "Campus",
        ),

      "mateo-slot-003":
        scheduleSlot(
            "mateo",
            "slot-003",
            "2026-10-09",
            17,
            0,
            18,
            0,
            "Personal appointment",
        ),
    },

    camila: {
      "camila-slot-001":
        scheduleSlot(
            "camila",
            "slot-001",
            "2026-10-09",
            9,
            30,
            11,
            0,
            "Statistics class",
            "Statistics lecture",
            "University",
        ),

      "camila-slot-002":
        scheduleSlot(
            "camila",
            "slot-002",
            "2026-10-09",
            12,
            0,
            13,
            0,
            "Lunch meeting",
        ),

      "camila-slot-003":
        scheduleSlot(
            "camila",
            "slot-003",
            "2026-10-09",
            15,
            30,
            17,
            0,
            "Study session",
        ),
    },

    lucas: {
      "lucas-slot-001":
        scheduleSlot(
            "lucas",
            "slot-001",
            "2026-10-09",
            8,
            0,
            9,
            0,
            "Gym",
        ),

      "lucas-slot-002":
        scheduleSlot(
            "lucas",
            "slot-002",
            "2026-10-09",
            11,
            0,
            12,
            30,
            "Database class",
            "",
            "Campus",
        ),

      "lucas-slot-003":
        scheduleSlot(
            "lucas",
            "slot-003",
            "2026-10-09",
            14,
            0,
            16,
            0,
            "Team project",
        ),
    },

    sofia: {
      "sofia-slot-001":
        scheduleSlot(
            "sofia",
            "slot-001",
            "2026-10-09",
            9,
            0,
            10,
            30,
            "Design class",
        ),

      "sofia-slot-002":
        scheduleSlot(
            "sofia",
            "slot-002",
            "2026-10-09",
            13,
            30,
            15,
            0,
            "Research meeting",
        ),

      "sofia-slot-003":
        scheduleSlot(
            "sofia",
            "slot-003",
            "2026-10-09",
            18,
            0,
            19,
            30,
            "Personal event",
        ),
    },
  };
}


function demoSchedules() {
  const slots =
    demoScheduleSlots();

  const schedules = {};

  for (
    const [
      userId,
      userSlots,
    ]
    of Object.entries(slots)
  ) {
    schedules[
        userId
    ] = {
      ownerId:
        userId,

      source:
        "google_calendar",

      lastImportedAt:
        new Date(),

      importedCount:
        Object.keys(
            userSlots,
        ).length,
    };
  }

  return schedules;
}


// ======================================================================
// SHARED AVAILABILITY
// ======================================================================

function demoAvailabilitySlots() {
  const privateSchedules =
    demoScheduleSlots();

  const result = {};

  for (
    const [
      userId,
      slots,
    ]
    of Object.entries(
        privateSchedules,
    )
  ) {
    result[userId] = {};

    for (
      const [
        slotId,
        slot,
      ]
      of Object.entries(slots)
    ) {
      result[
          userId
      ][
          slotId
      ] =
        availabilitySlot(slot);
    }
  }

  return result;
}


function demoAvailability(startDate, days) {
  if (startDate !== undefined) return demoDailyAvailability(startDate, days);
  const slots =
    demoAvailabilitySlots();

  const availability = {};

  for (
    const [
      userId,
      userSlots,
    ]
    of Object.entries(slots)
  ) {
    availability[
        userId
    ] = {
      ownerId:
        userId,

      slotCount:
        Object.keys(
            userSlots,
        ).length,

      updatedAt:
        new Date(),
    };
  }

  return availability;
}


// ======================================================================
// REAL ACCOUNT -> LEGACY GROUP MEMBER
// ======================================================================

function memberForAccount(
    uid,
    email,
    displayName,
) {
  let name =
    (displayName || "").trim();

  if (!name) {
    const localPart =
      email ?
        email.split("@")[0] :
        "user";

    name =
      localPart
          .split(/[._-]+/)
          .filter(
              (part) =>
                part.length > 0,
          )
          .map(
              (part) =>
                part[0].toUpperCase() +
                part.substring(1),
          )
          .join(" ") ||
      "User";
  }

  const words =
    name.split(/\s+/);

  const initials =
    (
      words[0][0] +
      (
        words.length > 1 ?
          words[
              words.length - 1
          ][0] :
          ""
      )
    ).toUpperCase();

  return {
    id: uid,
    name,
    initials,
    preferredStart:
      18 * 60,
    preferredEnd:
      21 * 60,
    busy: [],
  };
}


// ======================================================================
// EXPORTS
// ======================================================================

module.exports = {
  DEMO_USER_ID: DEFAULT_DEMO_USER_ID,
  DEFAULT_DEMO_USER_ID,
  DEMO_FRIEND_IDS,
  DEMO_LOCATION_ORIGIN,

  demoGroups,

  demoUsers,
  demoFriendships,
  demoLocations,

  demoSchedules,
  demoScheduleSlots,

  demoAvailability,
  demoAvailabilitySlots,
  demoBusyOn,

  memberForAccount,
};
