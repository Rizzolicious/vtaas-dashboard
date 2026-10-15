// Firebase web configuration is public client configuration. Replace these
// values with the Firebase project's Web app and Realtime Database settings.
window.VTAAS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCfmP5ACNwcSZJX04U3WK72VZAqAXuRAnw",
  authDomain: "vt-aas.firebaseapp.com",
  databaseURL: "https://vt-aas-default-rtdb.firebaseio.com",
  projectId: "vt-aas",
  appId: "1:750798651750:web:4431448b75f0da584dc8a7",
  vehicleId: "vehicle_01"
};

window.vtaasFirebaseReady = new Promise(resolve => {
  window.resolveVtaasFirebase = resolve;
});
