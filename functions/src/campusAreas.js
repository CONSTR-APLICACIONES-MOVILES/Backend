/*
  Campus areas: the places an activity can happen. The ids are the same locationAreaId values publishActivity accepts (activityLifecycle.js), so analytics (BQ11) and the apps share one list. Coordinates let the apps estimate travel time (Android F3/F7); aliases match legacy free-text locations to an area. Stored in campusAreas/{id}; written only by the seed script.*/
const CAMPUS_AREAS = [
  {id: "central_library", name: "Central Library", lat: 4.6021, lng: -74.0654, order: 1,
    aliases: ["library", "biblioteca", "central library"]},
  {id: "mario_laserna", name: "Mario Laserna Building", lat: 4.6027, lng: -74.0649, order: 2,
    aliases: ["mario laserna", "laserna", "ml "]},
  {id: "campus_north", name: "North Campus · Sports Center", lat: 4.6046, lng: -74.0643, order: 3,
    aliases: ["north", "norte", "sports", "deport", "gym"]},
  {id: "campus_south", name: "South Campus · Student Union", lat: 4.6000, lng: -74.0667, order: 4,
    aliases: ["south", "sur", "student union", "cafeter", "las aguas"]},
  {id: "outside_campus", name: "Outside campus", lat: null, lng: null, order: 5,
    aliases: ["apartment", "home", "casa", "main st"]},
];

module.exports = {CAMPUS_AREAS};
