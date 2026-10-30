const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {ServiceError} = require("./errors");

const INPUT_FIELDS = {
  getActivity: ["activityId"],
  getActivityRecommendations: ["activityId", "date", "durationMinutes", "minimumNoticeMinutes", "limit"],
  presentActivityRecommendations: ["activityId", "recommendationIds"],
  acceptActivityRecommendation: ["activityId", "recommendationId"],
  modifyActivityRecommendation: ["activityId", "recommendationId", "startTime", "endTime"],
  getActivityRecommendationAnalytics: ["activityId"],
};

function createActivityCallables(service) {
  return Object.fromEntries([
    "getActivity", "getActivityRecommendations", "presentActivityRecommendations",
    "acceptActivityRecommendation", "modifyActivityRecommendation", "getActivityRecommendationAnalytics",
  ].map((name) => [name, onCall({region: "us-central1"}, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
    if (!request.data || typeof request.data !== "object" || Array.isArray(request.data)) {
      throw new HttpsError("invalid-argument", "Supply an object containing activityId.");
    }
    if (Object.keys(request.data).some((key) => !INPUT_FIELDS[name].includes(key))) {
      throw new HttpsError("invalid-argument", "The request contains unsupported fields.");
    }
    try {
      return await service[name](request.auth.uid, request.data);
    } catch (error) {
      if (error instanceof ServiceError) throw new HttpsError(error.code, error.message);
      throw error;
    }
  })]));
}

module.exports = {createActivityCallables};
