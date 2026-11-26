// Andes Events for the Java app: the published university events (collection andesEvents, the same catalog the
// Flutter app reads) and the events each person added to their Schedule. An added event is kept in
// andesSchedule/{uid}/events/{eventId} as a busy block of its Bogota day, and getScheduleDay adds those blocks
// to the person's busy time, so the event counts in the comparison with friends while friends only ever see
// busy minutes. It is kept apart from availability/{uid}/days, so importing Google Calendar again never erases it.
const {FieldValue} = require("firebase-admin/firestore");
const {requireThat, documentId} = require("./errors");
const {localDate, dayStart, MINUTE} = require("./availability");

const CATEGORIES = ["academic", "cultural", "sports"];

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate() : null;
}

/** A published, complete event or null; unknown categories become "other" (same rules as the Flutter parser). */
function parseAndesEvent(id, data) {
  if (!id || !data || data.published !== true) return null;
  const title = text(data.title), description = text(data.description);
  const category = text(data.category), location = text(data.location);
  const start = toDate(data.start), end = toDate(data.end);
  if (!title || !description || !category || !location || !start || !end || end <= start) return null;
  if (data.sourceUrl != null && typeof data.sourceUrl !== "string") return null;
  const normalized = category.toLowerCase();
  return {id, title, description, category: CATEGORIES.includes(normalized) ? normalized : "other",
    location, start, end, sourceUrl: data.sourceUrl ?? null};
}

function row(event) {
  return {id: event.id, title: event.title, description: event.description, category: event.category,
    location: event.location, start: event.start.toISOString(), end: event.end.toISOString(),
    sourceUrl: event.sourceUrl};
}

/** The busy minutes of the event on the Bogota day it starts, clipped to that day. */
function scheduleBlock(event) {
  const date = localDate(event.start);
  const midnight = dayStart(date);
  return {date, start: Math.max(0, Math.floor((event.start.getTime() - midnight) / MINUTE)),
    end: Math.min(1440, Math.ceil((event.end.getTime() - midnight) / MINUTE))};
}

/** Sorted busy blocks with overlapping or touching ones joined. */
function mergeBusy(blocks) {
  const merged = [];
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1];
    if (previous && block.start <= previous.end) previous.end = Math.max(previous.end, block.end);
    else merged.push({start: block.start, end: block.end});
  }
  return merged;
}

/** The Andes Events a person added on that date, as busy blocks only. */
async function andesBusy(db, ownerId, date) {
  const snapshot = await db.collection(`andesSchedule/${ownerId}/events`).where("date", "==", date).get();
  return snapshot.docs.map((doc) => doc.data())
      .filter((d) => Number.isInteger(d.startMinute) && Number.isInteger(d.endMinute) &&
        d.startMinute >= 0 && d.endMinute <= 1440 && d.startMinute < d.endMinute)
      .map((d) => ({start: d.startMinute, end: d.endMinute}));
}

class AndesEvents {
  constructor(db, {clock = () => new Date()} = {}) {
    this.db = db;
    this.clock = clock;
  }

  /** Every published event that has not ended, by start, and the ids this person already added. */
  async getAndesEvents(uid) {
    const now = this.clock();
    const [catalog, added] = await Promise.all([
      this.db.collection("andesEvents").where("published", "==", true).get(),
      this.db.collection(`andesSchedule/${uid}/events`).get(),
    ]);
    let invalidCount = 0;
    const events = [];
    for (const doc of catalog.docs) {
      const event = parseAndesEvent(doc.id, doc.data());
      if (!event) invalidCount++;
      else if (event.end > now) events.push(event);
    }
    events.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    return {events: events.map(row), invalidCount, addedIds: added.docs.map((doc) => doc.id)};
  }

  /** Adds the event once. The catalog is read again inside the transaction: a missing, unpublished or ended
   * event is refused, and when the client sends the time and place it showed, a change is refused too, so
   * nobody adds something different from what they saw (an offline add sent later). Adding twice is fine. */
  async addAndesEventToSchedule(uid, input) {
    const eventId = documentId(input.eventId, "eventId");
    const shown = ["start", "end", "location"].filter((key) => input[key] !== undefined);
    requireThat(shown.length === 0 || (shown.length === 3 && shown.every((key) => typeof input[key] === "string")),
        "invalid-argument", "Send start, end and location together.");
    const mine = this.db.doc(`andesSchedule/${uid}/events/${eventId}`);
    const catalog = this.db.doc(`andesEvents/${eventId}`);
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(mine);
      if (existing.exists) return {added: true, alreadyAdded: true, date: existing.data().date};
      const record = await tx.get(catalog);
      requireThat(record.exists, "not-found", "This event is no longer available.");
      const event = parseAndesEvent(eventId, record.data());
      requireThat(event && event.end > this.clock(), "failed-precondition",
          "This event is invalid or has already ended.");
      if (shown.length) {
        requireThat(input.start === event.start.toISOString() && input.end === event.end.toISOString() &&
          input.location === event.location, "failed-precondition",
        "Event time or location changed. Review the updated event before adding it.");
      }
      const block = scheduleBlock(event);
      tx.set(mine, {eventId, title: event.title, location: event.location, start: event.start, end: event.end,
        date: block.date, startMinute: block.start, endMinute: block.end, addedAt: FieldValue.serverTimestamp()});
      return {added: true, alreadyAdded: false, date: block.date};
    });
  }

  async removeAndesEventFromSchedule(uid, input) {
    const eventId = documentId(input.eventId, "eventId");
    await this.db.doc(`andesSchedule/${uid}/events/${eventId}`).delete();
    return {removed: true};
  }
}

module.exports = {AndesEvents, parseAndesEvent, scheduleBlock, mergeBusy, andesBusy};
