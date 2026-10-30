// Shared transactional dispatcher. Preserve main's BQ6 clock/response contract
// while recording BQ14 receipts and revalidating membership and confirmation.
async function dispatchPendingReminders(db, {clock = () => new Date()} = {}) {
  return require('./reminderInsights').dispatchPendingReminders(db, clock());
}
module.exports = {dispatchPendingReminders};
