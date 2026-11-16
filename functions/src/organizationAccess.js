const {HttpsError} = require('firebase-functions/v2/https');

// Organization analytics permission is provisioned by an administrator, never
// taken from request.data or an editable user profile.
function requireOrganizationAnalytics(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  if (request.auth.token?.orgAnalytics !== true) {
    throw new HttpsError('permission-denied', 'Organization analytics access is required.');
  }
}
module.exports = {requireOrganizationAnalytics};
