const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {ServiceError} = require("./errors");
const {requireOrganizationAnalytics} = require('./organizationAccess');
const FIELDS = {
  setUsername:['username','clientUserId'], searchPeople:['query','cursor','limit'],getPublicPerson:['userId'],
  getFriends:['cursor','limit'],changeFriendship:['userId','action','expectedVersion','clientUserId'],
  recordCreationAttempt: ['attemptId','requestId','phase','startedAt','outcome','durationMs','errorCode','clientUserId'],
  getCoordinationInsight: [], getResponseTimeEstimates: [], getRecommendedSlotPosition: [], prepareProposalComparison: ['date', 'friendIds'],
  discover: ['query','kind','category','cursor','limit'], getSharedProfile: ['userId'],
  getActivityMaterials: ['activityId'], saveActivityMaterials: ['activityId','expectedVersion','topics','resources','clientUserId'], setTopicCompletion: ['activityId','topicId','completed','clientUserId'],
  createShareLink: ['requestId','kind','entityId','hours','clientUserId'], resolveShareLink: ['token'], joinSharedGroup: ['token','clientUserId'],
  getShareLinks: ['entityId'], revokeShareLink: ['linkId','clientUserId'], exportActivityCalendar: ['activityId'], getCalendarImportStatus: [],
  getCommunityPeers: [], createGroup: ["requestId", "name", "category", "inviteeIds"],
  getGroupInvitations: [], respondGroupInvitation: ["groupId", "response"],
  revokeGroupInvitation: ["groupId", "inviteeId"], getGroupDetails: ["groupId"],
  updatePresence: ["status", "visibility", "expiresAt", "clientUserId"], updatePreferences: ["preferences", "clientUserId"],
  validatePlanningSlot: ['participantIds', 'groupId', 'sourceSlotId', 'startTime', 'endTime', 'timeZone'],
  publishActivity: ['requestId', 'groupId', 'fields', 'participantIds', 'startTime', 'endTime', 'timeZone', 'comparisonId', 'minimumNoticeMinutes', 'locationAreaId', 'measurementVersion', 'comparisonEvidenceId'],
  updateActivityDetails: ['activityId', 'expectedVersion', 'fields'],
  cancelActivity: ['activityId', 'expectedVersion'],
  getScheduleFriends: ["groupId"], getScheduleDay: ["date", "friendIds"],
  importCalendarAvailability: ["startDate", "days", "intervals"],
  getProfile: [], updateProfile: ["fields", "clientUserId"], getAlerts: [], getActivities: [],
  setActivityReminder: ["activityId", "minutesBefore"],
  markNotificationEventsRead: ["ids", "clientUserId"],
  markAlertsRead: ["ids", "clientUserId"], respondToActivityInvitation: ["id", "response", "clientUserId"],
};
function createMobileCallables(service) {
  return Object.fromEntries(Object.entries(FIELDS).map(([name, fields]) => [name,
    onCall({region: "us-central1"}, async (request) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
      if (name === 'getCoordinationInsight') requireOrganizationAnalytics(request);
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
