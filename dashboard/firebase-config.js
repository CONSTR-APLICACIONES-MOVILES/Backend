// web config of the real firebase project
// copy the values from the firebase console: project settings, your apps, web app
// these values are not secret, the firestore rules protect the data
export const firebaseConfig = {
  apiKey: "AIzaSyDuAVN9SOfIxr4g-K_rqFGKzFhVuFO3U1k",
  authDomain: "parchapp-ee6cc.firebaseapp.com",
  projectId: "parchapp-ee6cc",
  appId: "1:718308941728:web:abbff5e172d045a7998ec5",
};

// on localhost the dashboard uses the local emulators, so it can be tested without the real project
export const useEmulators = ["localhost", "127.0.0.1"].includes(location.hostname);
export const emulatorProjectId = "demo-parchapp";
