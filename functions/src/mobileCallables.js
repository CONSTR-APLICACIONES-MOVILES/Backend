const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {ServiceError} = require("./errors");
const FIELDS = {
  getScheduleFriends: [], getScheduleDay: ["date", "friendIds"],
  importCalendarAvailability: ["startDate", "days", "intervals"],
  getProfile: [], updateProfile: ["fields", "clientUserId"], getAlerts: [], getActivities: [],
  markAlertsRead: ["ids", "clientUserId"], respondToActivityInvitation: ["id", "response", "clientUserId"],
};
function createMobileCallables(service) {
  return Object.fromEntries(Object.entries(FIELDS).map(([name, fields]) => [name,
    onCall({region: "us-central1"}, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
      if (request.data?.clientUserId !== undefined && request.data.clientUserId !== request.auth.uid) {
        throw new HttpsError("permission-denied", "This pending operation belongs to another account.");
      }
      if (!request.data || typeof request.data !== "object" || Array.isArray(request.data) ||
        Object.keys(request.data).some((key) => !fields.includes(key))) {
        throw new HttpsError("invalid-argument", "Unsupported request fields.");
      }
      try { return await service[name](request.auth.uid, request.data); }
      catch (error) {
        if (error instanceof ServiceError) throw new HttpsError(error.code, error.message);
        throw error;
      }
    })]));
}
module.exports = {createMobileCallables};
