const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {requireOrganizationAnalytics} = require('./organizationAccess');
const {refreshScheduleImportInsight} = require('./scheduleInsights');

function createScheduleInsightCallable(db) {
  return onCall({region: 'us-central1', invoker: 'public'}, async request => {
    requireOrganizationAnalytics(request);
    if (request.data != null && (typeof request.data !== 'object' ||
        Array.isArray(request.data) || Object.keys(request.data).length)) {
      throw new HttpsError('invalid-argument', 'No arguments accepted.');
    }
    return refreshScheduleImportInsight(db);
  });
}
module.exports = {createScheduleInsightCallable};
