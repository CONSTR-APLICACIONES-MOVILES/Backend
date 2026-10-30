const {requireThat} = require('./errors');
function validateActivityLocation(value, label) {
  if (value === null) return null;
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => ['latitude','longitude','label','placeId'].includes(k)),
  'invalid-argument','Invalid map location.');
  requireThat(typeof value.latitude === 'number' && Number.isFinite(value.latitude) && Math.abs(value.latitude)<=90 &&
    typeof value.longitude === 'number' && Number.isFinite(value.longitude) && Math.abs(value.longitude)<=180,
  'invalid-argument','Choose valid map coordinates.');
  requireThat(typeof value.label === 'string' && value.label.trim() && value.label.length<=500 && value.label===label,
    'invalid-argument','The map point must match the location label.');
  requireThat(value.placeId === undefined || typeof value.placeId === 'string' && value.placeId.length>0 && value.placeId.length<=300,
    'invalid-argument','Invalid Google place.');
  return {latitude:value.latitude,longitude:value.longitude,label:value.label,
    ...(value.placeId ? {placeId:value.placeId} : {})};
}
function readActivityLocation(activity) {
  try { return validateActivityLocation(activity.locationDetails,activity.location); }
  catch (_) { return null; }
}
module.exports={validateActivityLocation,readActivityLocation};
