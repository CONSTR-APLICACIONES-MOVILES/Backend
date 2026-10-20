const {requireThat, documentId, integer} = require("./errors");
const {localDate, dayStart, MINUTE, hasSchedule} = require("./availability");

const DAY = 1440 * MINUTE;
function validDate(value) {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(dayStart(value)) && localDate(new Date(dayStart(value))) === value,
  "invalid-argument", "Supply a valid YYYY-MM-DD date.");
  return value;
}
function iso(value) {
  return value ? (value.toDate ? value.toDate() : new Date(value)).toISOString() : null;
}

class MobileService {
  constructor(db, {clock = () => new Date(), userLookup} = {}) {
    this.db = db;
    this.clock = clock;
    this.userLookup = userLookup || ((uid) => require("firebase-admin/auth").getAuth().getUser(uid));
  }

  async groups(uid) {
    return (await this.db.collection("groups").where("memberIds", "array-contains", uid).get()).docs;
  }

  async getScheduleFriends(uid) {
    const friends = new Map();
    for (const doc of await this.groups(uid)) {
      for (const member of doc.data().members || []) {
        if (member.id !== uid) friends.set(member.id,
            {id: member.id, name: member.name, initials: member.initials || ""});
      }
    }
    return {friends: [...friends.values()]};
  }

  async getScheduleDay(uid, input) {
    const date = validDate(input.date);
    requireThat(Array.isArray(input.friendIds) && input.friendIds.length <= 10 &&
      new Set(input.friendIds).size === input.friendIds.length, "invalid-argument", "Choose up to 10 distinct friends.");
    input.friendIds.forEach((id) => documentId(id, "friendId"));
    const groups = await this.groups(uid);
    const peers = new Map();
    for (const group of groups) {
      for (const member of group.data().members || []) peers.set(member.id, member);
    }
    requireThat(input.friendIds.every((id) => id !== uid && peers.has(id)),
        "permission-denied", "Only members of your shared groups may be compared.");
    const today = localDate(this.clock());
    const schedules = await Promise.all([uid, ...input.friendIds].map(async (ownerId) => {
      const snapshot = await this.db.doc(`availability/${ownerId}/days/${date}`).get();
      const saved = snapshot.data();
      const legacy = peers.get(ownerId);
      // Legacy Java blocks have no date. Never project them into future days.
      const busy = saved ? saved.busy : date === today && !legacy?.calendarSync && hasSchedule(legacy || {}) ? legacy.busy : null;
      return {ownerId, known: busy !== null, busy: busy || [],
        updatedAt: saved ? iso(saved.updatedAt) : null};
    }));
    return {date, timeZone: "America/Bogota", schedules};
  }

  async importCalendarAvailability(uid, input) {
    const startDate = validDate(input.startDate);
    requireThat(startDate === localDate(this.clock()), "invalid-argument", "Import must start today in Bogota.");
    const days = integer(input.days, 1, 56, "days");
    requireThat(Array.isArray(input.intervals) && input.intervals.length <= 2000,
        "invalid-argument", "Supply at most 2000 busy intervals.");
    const start = dayStart(startDate);
    const end = start + days * DAY;
    const intervals = input.intervals.map((block) => {
      requireThat(block && Object.keys(block).every((key) => ["start", "end"].includes(key)) &&
        typeof block.start === "string" && typeof block.end === "string",
      "invalid-argument", "Calendar data may contain only start and end.");
      const from = Date.parse(block.start), to = Date.parse(block.end);
      requireThat(Number.isFinite(from) && Number.isFinite(to) && from < to && from < end && to > start,
          "invalid-argument", "Invalid or out-of-range busy interval.");
      return {from: Math.max(start, from), to: Math.min(end, to)};
    });
    const byDate = [];
    for (let day = start; day < end; day += DAY) {
      const raw = intervals.filter((b) => b.from < day + DAY && b.to > day)
          .map((b) => ({start: Math.max(0, Math.floor((b.from - day) / MINUTE)),
            end: Math.min(1440, Math.ceil((b.to - day) / MINUTE))})).sort((a, b) => a.start - b.start);
      const busy = [];
      for (const block of raw) {
        const previous = busy[busy.length - 1];
        if (previous && block.start <= previous.end) previous.end = Math.max(previous.end, block.end);
        else busy.push({...block});
      }
      byDate.push({date: localDate(new Date(day)), busy});
    }
    const groups = await this.groups(uid);
    requireThat(groups.length + days < 450, "resource-exhausted", "Too many groups for one import.");
    await this.db.runTransaction(async (tx) => {
      const currentGroups = groups.length ? await tx.getAll(...groups.map((g) => g.ref)) : [];
      for (const day of byDate) tx.set(this.db.doc(`availability/${uid}/days/${day.date}`),
          {...day, updatedAt: this.clock(), source: "google"});
      // Preserve the existing Java representation and every other member's data.
      for (const group of currentGroups) {
        const data = group.data();
        if (!data?.memberIds.includes(uid)) continue;
        tx.update(group.ref, {members: data.members.map((member) => member.id === uid ?
          {...member, busy: byDate[0].busy, busyDate: startDate, calendarSync: true} : member)});
      }
    });
    return {days, intervals: intervals.length};
  }

  async getProfile(uid) {
    const [profile, user, groups] = await Promise.all([
      this.db.doc(`profiles/${uid}`).get(), this.userLookup(uid), this.groups(uid),
    ]);
    const activities = (await Promise.all(groups.map((g) => this.db.collection("activities")
        .where("groupId", "==", g.id).get()))).flatMap((s) => s.docs);
    // No attendance tracking exists yet; never fabricate an on-time percentage.
    return {...profile.data(), id: uid,
      name: profile.data()?.name || user.displayName || user.email || "",
      verified: !!user.emailVerified, activeGroups: groups.length,
      plansCompleted: activities.filter((a) => {
        const data = a.data();
        return data.createdBy === uid && data.status === "CONFIRMED" && data.endTime &&
          Date.parse(iso(data.endTime)) <= this.clock().getTime();
      }).length, onTimeRate: null};
  }

  async updateProfile(uid, input) {
    const fields = input.fields;
    requireThat(fields && typeof fields === "object" && !Array.isArray(fields), "invalid-argument", "Supply profile fields.");
    const strings = {name: 120, program: 160, campus: 160, university: 160, studentId: 80};
    const allowed = [...Object.keys(strings), "semester", "year", "academicLevel", "status", "photoData"];
    requireThat(Object.keys(fields).length > 0 && Object.keys(fields).every((k) => allowed.includes(k)),
        "invalid-argument", "Unsupported profile field.");
    for (const [key, limit] of Object.entries(strings)) {
      if (fields[key] !== undefined) requireThat(typeof fields[key] === "string" &&
        fields[key].length <= limit && (key !== "name" || fields[key].trim().length > 0),
      "invalid-argument", `Invalid ${key}.`);
    }
    if (fields.semester !== undefined) integer(fields.semester, 0, 20, "semester");
    if (fields.year !== undefined) integer(fields.year, 0, 2100, "year");
    if (fields.academicLevel !== undefined) requireThat(["undergraduate", "graduate", "master", "phd"].includes(fields.academicLevel), "invalid-argument", "Invalid academic level.");
    if (fields.status !== undefined) requireThat(["active", "busy"].includes(fields.status), "invalid-argument", "Invalid status.");
    if (fields.photoData !== undefined) requireThat(typeof fields.photoData === "string" &&
      fields.photoData.length <= 180000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(fields.photoData),
    "invalid-argument", "Use an image smaller than 130 KB.");
    if (fields.photoData !== undefined) {
      const encoded = fields.photoData.split(",")[1];
      const bytes = Buffer.from(encoded, "base64");
      requireThat(encoded.length % 4 === 0 && bytes.toString("base64") === encoded && bytes.length <= 130000,
          "invalid-argument", "Invalid photo encoding or size.");
    }
    const before = await this.getProfile(uid);
    const groups = fields.name !== undefined ? await this.groups(uid) : [];
    requireThat(groups.length < 450, "resource-exhausted", "Too many groups for one profile update.");
    await this.db.runTransaction(async (tx) => {
      const current = groups.length ? await tx.getAll(...groups.map((g) => g.ref)) : [];
      tx.set(this.db.doc(`profiles/${uid}`), {...fields, updatedAt: this.clock()}, {merge: true});
      if (fields.name !== undefined) {
        const words = fields.name.trim().split(/\s+/);
        const initials = (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
        for (const group of current) {
          const data = group.data();
          if (data?.memberIds.includes(uid)) tx.update(group.ref, {
            members: data.members.map((m) => m.id === uid ? {...m, name: fields.name.trim(), initials} : m),
          });
        }
      }
    });
    return {...before, ...fields};
  }

  async getAlerts(uid) {
    const groups = await this.groups(uid);
    const pages = await Promise.all(groups.map((g) => this.db.collection("activities")
        .where("groupId", "==", g.id).orderBy("createdAt", "desc").limit(100).get()));
    const activities = pages.flatMap((s) => s.docs).filter((a) => a.data().createdBy !== uid)
        .sort((a, b) => Date.parse(iso(b.data().createdAt)) - Date.parse(iso(a.data().createdAt))).slice(0, 200);
    if (!activities.length) return {alerts: []};
    const states = await this.db.getAll(...activities.map((a) => this.db.doc(`inboxes/${uid}/items/${a.id}`)));
    return {alerts: activities.map((a, index) => ({id: a.id, title: a.data().title,
      groupSize: groups.find((g) => g.id === a.data().groupId).data().memberIds.length,
      description: [a.data().description, a.data().location, a.data().date, a.data().time].filter(Boolean).join(" • "),
      createdAt: iso(a.data().createdAt), isRead: states[index].data()?.isRead || false,
      response: states[index].data()?.response || null, studySessionId: a.id}))};
  }

  async getActivities(uid) {
    const groups = await this.groups(uid);
    const pages = await Promise.all(groups.map((g) => this.db.collection("activities")
        .where("groupId", "==", g.id).orderBy("createdAt", "desc").limit(100).get()));
    return {activities: pages.flatMap((s) => s.docs)
        .sort((a, b) => Date.parse(iso(b.data().createdAt)) - Date.parse(iso(a.data().createdAt)))
        .slice(0, 200).map((doc) => ({id: doc.id, title: doc.data().title,
          groupId: doc.data().groupId, date: doc.data().date || "", time: doc.data().time || "",
          location: doc.data().location || "", status: doc.data().status}))};
  }

  async requireInvitation(tx, uid, id) {
    documentId(id, "activityId");
    const activity = (await tx.get(this.db.doc(`activities/${id}`))).data();
    requireThat(activity, "not-found", "Activity not found.");
    const groupRef = this.db.doc(`groups/${activity.groupId}`);
    const group = (await tx.get(groupRef)).data();
    requireThat(group?.memberIds.includes(uid) && activity.createdBy !== uid,
        "permission-denied", "This invitation is not available to you.");
    return {activity, groupRef};
  }

  async markAlertsRead(uid, input) {
    requireThat(Array.isArray(input.ids) && input.ids.length <= 200 && new Set(input.ids).size === input.ids.length,
        "invalid-argument", "Supply up to 200 distinct alert IDs.");
    await this.db.runTransaction(async (tx) => {
      for (const id of input.ids) await this.requireInvitation(tx, uid, id);
      for (const id of input.ids) tx.set(this.db.doc(`inboxes/${uid}/items/${id}`),
          {isRead: true}, {merge: true});
    });
    return {ids: input.ids};
  }

  async respondToActivityInvitation(uid, input) {
    requireThat(["accepted", "maybe", "declined"].includes(input.response), "invalid-argument", "Invalid invitation response.");
    await this.db.runTransaction(async (tx) => {
      await this.requireInvitation(tx, uid, input.id);
      const ref = this.db.doc(`inboxes/${uid}/items/${input.id}`);
      const existing = (await tx.get(ref)).data();
      requireThat(!existing?.response || existing.response === input.response,
          "failed-precondition", "This invitation already has a response.");
      // Per-activity response, independent of legacy group-level RSVP arrays.
      if (!existing?.response) tx.set(ref, {isRead: true, response: input.response,
        respondedAt: this.clock()}, {merge: true});
    });
    return {id: input.id, response: input.response};
  }
}

module.exports = {MobileService, validDate};
