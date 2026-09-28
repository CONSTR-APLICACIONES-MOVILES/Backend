/**
   Demo groups of the prototype. Port of DemoData.java in the Android app (Sprint-2-Java), so a seeded Firestore shows the same groups as the app's in-memory mode. Keep both in sync.
   Times are minutes since midnight. Busy blocks store only start and end, never titles, places or attendees (data minimisation, Sprint 1 scenario 9.5).
 */

const DEMO_USER_ID = "alex";

/** Busy hours are start/end pairs in hours, for example 18, 19.5. */
function member(id, name, preferredStartHour, preferredEndHour, ...busyHours) {
  const busy = [];
  for (let i = 0; i + 1 < busyHours.length; i += 2) {
    busy.push({start: Math.trunc(busyHours[i] * 60), end: Math.trunc(busyHours[i + 1] * 60)});
  }
  return {
    id,
    name,
    initials: name.substring(0, 1),
    preferredStart: preferredStartHour * 60,
    preferredEnd: preferredEndHour * 60,
    busy,
  };
}

function group(name, icon, planTitle, members, goingIds) {
  return {
    name,
    icon,
    planTitle,
    members,
    // Not read by the apps: lets the security rules check membership (arrays of maps cannot be searched).
    memberIds: members.map((m) => m.id),
    goingIds,
    maybeIds: [],
    pendingInvites: [],
  };
}

function roomies() {
  const members = [
    member(DEMO_USER_ID, "Alex", 18, 21, 8, 12, 14, 16),
    member("mateo", "Mateo", 19, 22, 9, 13, 18, 19.5),
    member("camila", "Camila", 17, 20, 10, 17),
    member("lucas", "Lucas", 20, 23, 8, 10, 13, 18),
  ];
  return group("Roomies Main St", "⌂", "Weekly House Dinner & Grocery Run", members,
      [DEMO_USER_ID, "mateo", "camila", "lucas"]);
}

/* Larger groups with deterministic schedules, so BQ1 gets several group sizes. */
function generated(id, name, icon, planTitle, size, going) {
  const members = [member(DEMO_USER_ID, "Alex", 18, 21, 8, 12, 14, 16)];
  const goingIds = [];
  for (let i = 1; i < size; i++) {
    const classStart = 8 + (i % 4);
    const classEnd = classStart + 2 + (i % 3);
    const afternoonStart = 14 + (i % 3);
    const memberId = `${id}_m${i}`;
    members.push(member(memberId, `Member ${i}`, 17 + (i % 3), 21 + (i % 2),
        classStart, classEnd, afternoonStart, afternoonStart + 1.5));
    if (goingIds.length < going) {
      goingIds.push(memberId);
    }
  }
  return group(name, icon, planTitle, members, goingIds);
}

/* @return {Object<string, object>} group documents keyed by document ID */
function demoGroups() {
  return {
    roomies: roomies(),
    eng: generated("eng", "Engineering 2026", "🎓", "Linear Algebra midterm study", 8, 3),
    intramurals: generated("intramurals", "Campus Intramurals", "⚽", "5-a-side Soccer & Social", 6, 3),
    thesis: generated("thesis", "Thesis Support Group", "📌", "", 5, 0),
    choir: generated("choir", "University Choir", "🎵", "Rehearsal", 12, 7),
  };
}

/*Member entry for a real account. It starts with no busy blocks until calendar sync exists.
  The name comes from the email like UserProfile.fromAccount: maria.lopez@uni.edu -> "Maria Lopez".
 */
function memberForAccount(uid, email, displayName) {
  let name = (displayName || "").trim();
  if (!name) {
    const localPart = email ? email.split("@")[0] : "user";
    name = localPart.split(/[._-]+/)
        .filter((part) => part.length > 0)
        .map((part) => part[0].toUpperCase() + part.substring(1))
        .join(" ") || "User";
  }
  const words = name.split(/\s+/);
  const initials = (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return {id: uid, name, initials, preferredStart: 18 * 60, preferredEnd: 21 * 60, busy: []};
}

module.exports = {DEMO_USER_ID, demoGroups, memberForAccount};
