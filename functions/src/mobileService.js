const {requireThat, documentId, integer} = require("./errors");
const {localDate, dayStart, MINUTE, hasSchedule} = require("./availability");
const {ActivityLifecycle} = require('./activityLifecycle');

const {CommunityService, canShare, effectiveStatus, defaults} = require('./communityService');

const {ExpansionService} = require('./expansionService');
const {additionalAlerts} = require('./alertEvents');
const {prepareProposalComparison} = require('./coordinationInsights');

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
    this.lifecycle = new ActivityLifecycle(db, {clock});
    this.userLookup = userLookup || ((uid) => require("firebase-admin/auth").getAuth().getUser(uid));
    this.expansions = new ExpansionService(db, {clock, userLookup: this.userLookup});
    this.community = new CommunityService(db, {clock, userLookup: this.userLookup});
    this.social = new (require('./socialService').SocialService)(db,{clock,userLookup:this.userLookup});
  }

  getCommunityPeers(uid, input) { return this.community.getCommunityPeers(uid, input); }
  inviteGroupFriend(uid,input) { return new (require('./activityParticipants').ActivityParticipants)(this.db,{clock:this.clock}).inviteGroupFriend(uid,input); }
  getActivityParticipants(uid, input) { return new (require('./activityParticipants').ActivityParticipants)(this.db, {clock:this.clock}).getActivityParticipants(uid,input); }
  changeActivityParticipants(uid, input) { return new (require('./activityParticipants').ActivityParticipants)(this.db, {clock:this.clock}).changeActivityParticipants(uid,input); }
  setUsername(uid,input){return this.social.setUsername(uid,input);}
  searchPeople(uid,input){return this.social.searchPeople(uid,input);}
  getPublicPerson(uid,input){return this.social.getPublicPerson(uid,input);}
  getFriends(uid,input){return this.social.getFriends(uid,input);}
  changeFriendship(uid,input){return this.social.changeFriendship(uid,input);}
  createGroup(uid, input) { return this.community.createGroup(uid, input); }
  getGroupInvitations(uid, input) { return this.community.getGroupInvitations(uid, input); }
  respondGroupInvitation(uid, input) { return this.community.respondGroupInvitation(uid, input); }
  revokeGroupInvitation(uid, input) { return this.community.revokeGroupInvitation(uid, input); }
  getGroupDetails(uid, input) { return this.community.getGroupDetails(uid, input); }
  async updatePresence(uid, input) { await this.community.updatePresence(uid, input); return this.getProfile(uid); }
  async updatePreferences(uid, input) { await this.community.updatePreferences(uid, input); return this.getProfile(uid); }

  discover(uid, input) { return this.expansions.discover(uid, input); }
  getSharedProfile(uid, input) { return this.expansions.getSharedProfile(uid, input); }
  getActivityMaterials(uid, input) { return this.expansions.getActivityMaterials(uid, input); }
  saveActivityMaterials(uid, input) { return this.expansions.saveActivityMaterials(uid, input); }
  setTopicCompletion(uid, input) { return this.expansions.setTopicCompletion(uid, input); }
  createShareLink(uid, input) { return this.expansions.createShareLink(uid, input); }
  resolveShareLink(uid, input) { return this.expansions.resolveShareLink(uid, input); }
  joinSharedGroup(uid, input) { return this.expansions.joinSharedGroup(uid, input); }
  getShareLinks(uid, input) { return this.expansions.getShareLinks(uid, input); }
  revokeShareLink(uid, input) { return this.expansions.revokeShareLink(uid, input); }
  exportActivityCalendar(uid, input) { return this.expansions.exportActivityCalendar(uid, input); }
  getCalendarImportStatus(uid, input) { return this.expansions.getCalendarImportStatus(uid, input); }

  async groups(uid) {
    return (await this.db.collection("groups").where("memberIds", "array-contains", uid).get()).docs;
  }

  validatePlanningSlot(uid, input) { return this.lifecycle.validatePlanningSlot(uid, input); }
  prepareProposalComparison(uid, input) { return prepareProposalComparison(this.db, uid, input, this.clock()); }
  async getCoordinationInsight() {
    const doc = await this.db.doc('insights/bq9_comparison_confirmation').get();
    return {insight:doc.exists ? doc.data() : null};
  }
  async getResponseTimeEstimates(uid) {
    const groups = await this.groups(uid);
    if (!groups.length) return {by_group_size:[]};
    const insight = (await this.db.doc('insights/bq5_response_time').get()).data();
    const rows = (insight?.by_group_size || []).filter(r => Number.isInteger(r.group_size) &&
      r.group_size > 0 && Number.isFinite(r.estimate_minutes) && r.estimate_minutes > 0 &&
      ['all_responded','per_response'].includes(r.estimate_kind));
    const estimates = new Map();
    for (const group of groups) {
      const size = group.data().memberIds?.length || 0;
      if (!size) continue;
      const nearest = [...rows].sort((a,b) => Math.abs(a.group_size-size)-Math.abs(b.group_size-size) || a.group_size-b.group_size)[0];
      if (nearest) estimates.set(size,{group_size:size,estimate_minutes:nearest.estimate_minutes,estimate_kind:nearest.estimate_kind});
    }
    // Only the prediction applicable to this user's groups leaves the server.
    return {by_group_size:[...estimates.values()]};
  }
  async getRecommendedSlotPosition() {
    const insight = (await this.db.doc('insights/bq3_slot_acceptance').get()).data();
    const position = insight?.recommended_position;
    return {position:Number.isInteger(position) && position >= 1 && position <= 10 ? position : 1};
  }
  publishActivity(uid, input) { return this.lifecycle.publishActivity(uid, input); }
  recordCreationAttempt(uid, input) { return require('./activityInsights').recordCreationAttempt(this.db, uid, input, this.clock()); }
  updateActivityDetails(uid, input) { return this.lifecycle.mutate(uid, input, false); }
  cancelActivity(uid, input) { return this.lifecycle.mutate(uid, input, true); }

  async getScheduleFriends(uid, input = {}) {
    const friends = new Map();
    const groups = await this.groups(uid);
    if (input.groupId) {
      documentId(input.groupId, 'groupId');
      requireThat(groups.some(g => g.id === input.groupId), 'permission-denied', 'Group membership is required.');
    }
    for (const doc of groups.filter(g => !input.groupId || g.id === input.groupId)) {
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
      if (!await canShare(this.db, ownerId, uid, "scheduleVisibility")) return {ownerId, known: false, busy: [], updatedAt: null};
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
      const preferences = (await tx.get(this.db.doc(`profiles/${uid}`))).data()?.preferences;
      const shareWithGroups = !preferences?.scheduleVisibility || preferences.scheduleVisibility === 'groups';
      const currentGroups = groups.length ? await tx.getAll(...groups.map((g) => g.ref)) : [];
      for (const day of byDate) tx.set(this.db.doc(`availability/${uid}/days/${day.date}`),
          {...day, updatedAt: this.clock(), source: "google"});
      tx.set(this.db.doc(`calendarImports/${uid}`), {lastImportedAt: this.clock(), startDate, days, source: "google"});
      // Preserve the existing Java representation and every other member's data.
      for (const group of currentGroups) {
        const data = group.data();
        if (!data?.memberIds.includes(uid)) continue;
        tx.update(group.ref, {members: data.members.map((member) => {
          if (member.id !== uid) return member;
          if (shareWithGroups) return {...member, busy: byDate[0].busy, busyDate: startDate, calendarSync: true};
          const {busy, busyDate, ...identity} = member;
          return {...identity, calendarSync: true};
        })});
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
    return {...profile.data(), status: effectiveStatus(profile.data() || {}, this.clock()),
      statusExpiresAt: iso(profile.data()?.statusExpiresAt),
      preferences: {...defaults, ...profile.data()?.preferences}, id: uid,
      name: profile.data()?.name || user.displayName || user.email || "",
      verified: !!user.emailVerified, activeGroups: groups.length,
      plansCompleted: activities.filter((a) => {
        const data = a.data();
        return !data.cancelled && data.createdBy === uid && data.status === "CONFIRMED" && data.endTime &&
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
      const publicRef=this.db.doc(`publicPeople/${uid}`);
      const publicPerson=fields.name!==undefined?(await tx.get(publicRef)).data():null;
      tx.set(this.db.doc(`profiles/${uid}`), {...fields, ...(fields.status !== undefined ? {statusExpiresAt: null} : {}), updatedAt: this.clock()}, {merge: true});
      if(publicPerson)tx.update(publicRef,{name:fields.name.trim(),updatedAt:this.clock()});
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
    return {...before, ...fields, ...(fields.status !== undefined ? {statusExpiresAt: null} : {})};
  }

  async getAlerts(uid) {
    const groups = await this.groups(uid);
    const pages = await Promise.all(groups.map((g) => this.db.collection("activities")
        .where("groupId", "==", g.id).orderBy("createdAt", "desc").limit(100).get()));
    const activities = pages.flatMap((s) => s.docs).filter((a) => a.data().createdBy !== uid && !a.data().cancelled &&
          (!a.data().participantIds || a.data().participantIds.includes(uid)))
        .sort((a, b) => Date.parse(iso(b.data().createdAt)) - Date.parse(iso(a.data().createdAt))).slice(0, 200);
    const extra = await additionalAlerts(this.db,uid,groups,pages.flatMap(p=>p.docs),this.clock());
    if (!activities.length) return {alerts: extra.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,200)};
    const states = await this.db.getAll(...activities.map((a) => this.db.doc(`inboxes/${uid}/items/${a.id}`)));
    const invitations = activities.map((a, index) => ({kind: "invitation", id: a.id, title: a.data().title,
      groupSize: (a.data().participantIds || groups.find((g) => g.id === a.data().groupId).data().memberIds).length,
      description: [a.data().description, a.data().location, a.data().date, a.data().time].filter(Boolean).join(" • "),
      createdAt: iso(a.data().createdAt), isRead: states[index].data()?.isRead || false,
      response: states[index].data()?.response || null, studySessionId: a.id}));
    return {alerts: [...invitations,...extra].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,200)};
  }

  async getActivities(uid) {
    const groups = await this.groups(uid);
    const pages = await Promise.all(groups.map((g) => this.db.collection("activities")
        .where("groupId", "==", g.id).orderBy("createdAt", "desc").limit(100).get()));
    const records = pages.flatMap(s => s.docs)
      .sort((a, b) => Date.parse(iso(b.data().createdAt)) - Date.parse(iso(a.data().createdAt))).slice(0, 200);
    return {activities: await Promise.all(records.map(async doc => {
      const activity = doc.data();
      const group = groups.find(g => g.id === activity.groupId).data();
      const ids = (activity.participantIds || group.memberIds).filter(id => group.memberIds.includes(id));
      const states = ids.length ? await this.db.getAll(...ids.map(id => this.db.doc(`inboxes/${id}/items/${doc.id}`))) : [];
      const counts = {accepted: 0, maybe: 0, declined: 0, pending: 0, total: ids.length};
      ids.forEach((id, i) => { const response = id === activity.createdBy ? 'accepted' : states[i].data()?.response;
        counts[response || 'pending']++; });
      return {id: doc.id, title: activity.title, groupId: activity.groupId,
        date: activity.date || '', time: activity.time || '', location: activity.location || '',
        status: activity.status, cancelled: !!activity.cancelled,
        startTime: iso(activity.startTime), endTime: iso(activity.endTime), timeZone: activity.timeZone || 'America/Bogota',
        attendance: counts};
    }))};
  }

  async requireInvitation(tx, uid, id, responding = false) {
    documentId(id, "activityId");
    const activity = (await tx.get(this.db.doc(`activities/${id}`))).data();
    requireThat(activity, "not-found", "Activity not found.");
    const groupRef = this.db.doc(`groups/${activity.groupId}`);
    const group = (await tx.get(groupRef)).data();
    requireThat(group?.memberIds.includes(uid) && activity.createdBy !== uid,
        "permission-denied", "This invitation is not available to you.");
    requireThat(!activity.participantIds || activity.participantIds.includes(uid),
        "permission-denied", "You are not invited to this activity.");
    requireThat(!responding || !activity.cancelled, "failed-precondition", "This activity is cancelled.");
    return {activity, groupRef};
  }

  async setActivityReminder(uid, input) {
    documentId(input.activityId, "activityId");
    requireThat([0, 15, 30, 60].includes(input.minutesBefore), "invalid-argument",
        "Reminder must be disabled or set to 15, 30 or 60 minutes before the activity.");
    const activityRef = this.db.doc(`activities/${input.activityId}`);
    return this.db.runTransaction(async tx => {
      const activity = (await tx.get(activityRef)).data();
      requireThat(activity, "not-found", "Activity not found.");
      const groupRef = this.db.doc(`groups/${activity.groupId}`);
      const group = (await tx.get(groupRef)).data();
      requireThat(group?.memberIds?.includes(uid) && activity.createdBy === uid,
          "permission-denied", "Only the activity organizer can configure its reminder.");
      requireThat(!activity.cancelled, "failed-precondition", "This activity is cancelled.");

      const inboxRef = this.db.doc(`inboxes/${uid}/items/${input.activityId}`);
      const reminderRef = inboxRef.collection("reminders").doc("activity-reminder");
      const reminder = (await tx.get(reminderRef)).data();
      if (input.minutesBefore === 0) {
        if (reminder?.purpose === "activity" && reminder.status === "SCHEDULED") {
          tx.update(reminderRef, {status: "CANCELLED", cancelledAt: this.clock()});
        }
        if (activity.createdBy === uid) {
          tx.update(activityRef, {reminderMinutesBefore: 0, updatedAt: this.clock()});
        }
        tx.set(inboxRef, {activityId: input.activityId, groupId: activity.groupId,
          reminderMinutesBefore: 0}, {merge: true});
        return {activityId: input.activityId, minutesBefore: 0, enabled: false};
      }

      const startTime = activity.startTime?.toDate ? activity.startTime.toDate() :
        activity.startTime ? new Date(activity.startTime) : null;
      const now = this.clock();
      requireThat(startTime && Number.isFinite(startTime.getTime()) && startTime > now,
          "failed-precondition", "A future scheduled activity is required for reminders.");
      const scheduledAt = new Date(Math.max(now.getTime(),
          startTime.getTime() - input.minutesBefore * 60 * 1000));
      tx.set(reminderRef, {
        activityId: input.activityId,
        groupId: activity.groupId,
        purpose: "activity",
        strategy: `activity_${input.minutesBefore}m_before`,
        sequence: 1,
        minutesBefore: input.minutesBefore,
        scheduledAt,
        sentAt: null,
        deliveredAt: null,
        openedAt: null,
        respondedAt: null,
        status: "SCHEDULED",
        updatedAt: now,
      });
      if (activity.createdBy === uid) {
        tx.update(activityRef, {reminderMinutesBefore: input.minutesBefore, updatedAt: now});
      }
      tx.set(inboxRef, {activityId: input.activityId, groupId: activity.groupId,
        reminderMinutesBefore: input.minutesBefore}, {merge: true});
      return {activityId: input.activityId, minutesBefore: input.minutesBefore,
        scheduledAt: scheduledAt.toISOString(), enabled: true};
    });
  }

  async markNotificationEventsRead(uid, input) {
    requireThat(Array.isArray(input.ids) && input.ids.every(id => /^(evt|grp|rem|friend)_[a-f0-9]{64}$/.test(id)), 'invalid-argument', 'Supply event notification IDs.');
    return this.markAlertsRead(uid,input);
  }

  async markAlertsRead(uid, input) {
    requireThat(Array.isArray(input.ids) && input.ids.length <= 200 && new Set(input.ids).size === input.ids.length,
        "invalid-argument", "Supply up to 200 distinct alert IDs.");
    const currentAlerts = (await this.getAlerts(uid)).alerts;
    const extraIds = new Set(currentAlerts.filter(a=>a.kind !== 'invitation').map(a=>a.id));
    await this.db.runTransaction(async (tx) => {
      for (const id of input.ids) {
        documentId(id,'alertId');
        if (!extraIds.has(id)) await this.requireInvitation(tx, uid, id);
      }
      for (const id of input.ids) tx.set(this.db.doc(`inboxes/${uid}/items/${id}`),
          {isRead: true}, {merge: true});
    });
    return {ids: input.ids};
  }

  async respondToActivityInvitation(uid, input) {
    requireThat(["accepted", "maybe", "declined"].includes(input.response), "invalid-argument", "Invalid invitation response.");
    await this.db.runTransaction(async (tx) => {
      const {activity} = await this.requireInvitation(tx, uid, input.id, true);
      const ref = this.db.doc(`inboxes/${uid}/items/${input.id}`);
      const existing = (await tx.get(ref)).data();
      requireThat((input.expectedResponse ?? null) === (existing?.response || null) || existing?.response === input.response,
          'aborted', 'Your response changed. Reload before trying again.');
      // Per-activity response, independent of legacy group-level RSVP arrays.
      if (existing?.response !== input.response) {
        const respondedAt = this.clock();
        const invitedAt = existing?.invitedAt?.toDate ? existing.invitedAt.toDate() :
          existing?.invitedAt ? new Date(existing.invitedAt) :
          activity.createdAt?.toDate ? activity.createdAt.toDate() : new Date(respondedAt);
        tx.set(ref, {isRead: true, response: input.response,
          firstResponse: existing?.firstResponse || existing?.response || input.response,
          respondedAt: existing?.respondedAt || respondedAt, lastResponseAt: respondedAt,
          responseMs: existing?.responseMs ?? Math.max(0, respondedAt.getTime() - invitedAt.getTime()),
          availabilityAtInvitation: existing?.availabilityAtInvitation || 'UNKNOWN'}, {merge: true});
        tx.set(this.db.doc(`activities/${input.id}/lifecycle/response-${uid}`), {
          type: 'RESPONSE_RECEIVED', activityId: input.id, actorId: uid,
          response: input.response, createdAt: existing?.respondedAt || respondedAt, updatedAt: respondedAt,
        }, {merge: true});
      }
    });
    return {id: input.id, response: input.response};
  }
}

module.exports = {MobileService, validDate};
