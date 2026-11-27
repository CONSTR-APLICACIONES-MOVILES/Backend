const {createHash} = require('node:crypto');
const hash = v => createHash('sha256').update(v).digest('hex');
const PREVIEW = 120;

// the text shown in the alert: the message cut to one line, or the shared slot
function preview(message) {
  const text = String(message.text || '').trim();
  if (message.kind === 'slot') return `Shared a common free slot: ${text}`;
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1)}…` : text;
}

/* Sprint 4: a new chat message becomes an alert in the inbox of the other people of that chat.
 * There is one alert per chat and person: each message replaces the previous one, so a busy chat does not fill
 * the inbox. getAlerts gives it a new id with each message, so a chat that was read is unread again with the next.
 * chat is {groupId} for a House Chat or {pairId} for a direct chat (pairId = both uids sorted, joined by "_"). */
async function recordChatMessage(db, chat, messageId, message) {
  const sender = message?.senderId;
  if (typeof sender !== 'string' || !sender) return 0;
  const senderName = message.senderName || 'A member';
  const createdAt = message.createdAt?.toDate ? message.createdAt.toDate() : new Date();
  let recipients, alert;
  if (chat.groupId) {
    const group = (await db.doc(`groups/${chat.groupId}`).get()).data();
    if (!group?.memberIds?.includes(sender)) return 0;
    recipients = group.memberIds.filter(id => id !== sender);
    alert = {chatKey: `group:${chat.groupId}`, groupId: chat.groupId, groupName: group.name || 'Group',
      title: `New message in ${group.name || 'your group'}`, description: `${senderName}: ${preview(message)}`};
  } else {
    const ids = String(chat.pairId || '').split('_');
    if (ids.length !== 2 || ids[0] === ids[1] || !ids.includes(sender)) return 0;
    recipients = ids.filter(id => id !== sender);
    // a direct chat is opened from a group, so the alert keeps a group both people share
    const groups = await db.collection('groups').where('memberIds', 'array-contains', sender).get();
    const shared = groups.docs.find(g => g.data().memberIds?.includes(recipients[0]));
    alert = {chatKey: `direct:${chat.pairId}`, groupId: shared?.id || null, groupName: shared?.data().name || null,
      title: `${senderName} sent you a message`, description: preview(message)};
  }
  if (!recipients.length) return 0;
  const refs = recipients.map(uid => db.doc(`alertEvents/${uid}/items/chat_${hash(alert.chatKey)}`));
  await db.runTransaction(async tx => {
    const current = await tx.getAll(...refs);
    refs.forEach((ref, i) => {
      const saved = current[i].data()?.createdAt;
      // triggers can arrive out of order: an older message never replaces a newer one
      if (saved && (saved.toDate ? saved.toDate() : new Date(saved)) > createdAt) return;
      tx.set(ref, {...alert, kind: 'chatMessage', messageId, senderId: sender, senderName,
        senderInitials: message.senderInitials || '?', createdAt});
    });
  });
  return recipients.length;
}

// the alert row for getAlerts; null when the person is no longer in the group of a House Chat
function chatAlertRow(doc, groupsOfUser) {
  const e = doc.data();
  const direct = String(e.chatKey || '').startsWith('direct:');
  if (!direct && !groupsOfUser.has(e.groupId)) return null;
  const createdAt = e.createdAt?.toDate ? e.createdAt.toDate() : new Date(e.createdAt);
  return {id: `chat_${hash(`${doc.id}:${e.messageId}`)}`, kind: 'chatMessage', title: e.title,
    description: e.description, createdAt: createdAt.toISOString(), groupId: e.groupId || null,
    groupName: e.groupName || null, chatFriendId: direct ? e.senderId : null,
    chatFriendName: direct ? e.senderName : null, chatFriendInitials: direct ? e.senderInitials : null,
    studySessionId: null};
}

module.exports = {recordChatMessage, chatAlertRow};
