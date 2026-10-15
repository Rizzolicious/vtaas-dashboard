# Firebase cloud setup for VT&AAS

The dashboard now has a Firebase client for email/password sign-in, live Realtime Database updates, and shared incident history. Firebase project settings are intentionally blank until you create your project. Until then, the existing local Node server and demo mode continue to work.

## 1. Create the Firebase project

1. Create a Firebase project in the [Firebase console](https://console.firebase.google.com/).
2. In **Authentication → Sign-in method**, enable **Email/Password**.
3. In **Realtime Database**, create a database. Keep its location and copy the database URL.
4. In **Project settings → General**, register a Web app and copy its web configuration values.
5. Open `firebase-config.js` and fill `apiKey`, `authDomain`, `databaseURL`, `projectId`, and `appId`. Keep `vehicleId` as `vehicle_01` unless you change it in both the ESP32 and database paths.
6. In **Realtime Database → Rules**, publish the rules from `database.rules.json`. The rule file is now configured with the ESP32 account UID you provided.

The web configuration is public client configuration. Do not put a service-account JSON, Admin SDK key, or database secret in this file or in browser code. For the already-created `vt-aas` project, this configuration is in `firebase-config.js` and the ESP32 account UID is in `database.rules.json`.

## 2. Create user and device accounts

Register dashboard users at `/register`. Signed-in users can read vehicle telemetry and incidents. They cannot write device data.

Create a separate Email/Password account for the ESP32 in **Authentication → Users → Add user**. Copy its UID into the database rules. Put that device account's email and password in the ESP32's private firmware configuration; do not reuse a student's dashboard password or commit the credentials to a public repository. Rules restrict that account to writing under the vehicle tree. Never enable public database reads or writes.

## 3. Firmware cloud data contract

The ESP32 should send authenticated HTTPS requests to Firebase Realtime Database REST endpoints:

- `PUT https://<database-host>/vehicles/vehicle_01/latest.json?auth=<ID_TOKEN>` for each current telemetry sample. Overwrite this one object; do not create a permanent database row for every fast sensor sample.
- `PUT https://<database-host>/vehicles/vehicle_01/events/<event_id>.json?auth=<ID_TOKEN>` when an accident, SOS, or overspeed event changes. Reuse the same stable `event_id` as countdown/status updates arrive. Preserve the crash location and evidence fields in this record.

Obtain an ID token by signing in the device account through Firebase Authentication's `accounts:signInWithPassword` REST endpoint using the web API key. ID tokens expire; firmware must refresh them using the refresh token before they expire. Use HTTPS certificate validation on the ESP32. The REST flow is documented by Firebase: [Realtime Database REST API](https://firebase.google.com/docs/database/rest/start) and [Authenticate REST requests](https://firebase.google.com/docs/database/rest/auth).

Send the latest value in the dashboard's existing JSON shape, for example:

```json
{
  "device_id": "vehicle_01",
  "timestamp": "2026-10-14T12:00:00Z",
  "message_type": "telemetry",
  "vehicle_status": "NORMAL",
  "accident_state": "NONE",
  "speed_kmh": 42.5,
  "speed_limit_kmh": 80,
  "acceleration": { "x": 0.12, "y": -0.08, "z": 9.72, "unit": "m/s2" },
  "gyroscope": { "x": 0.5, "y": -0.2, "z": 1.1, "unit": "deg/s" },
  "gps": { "valid": true, "latitude": 21.708444, "longitude": 72.995917, "speed_kmh": 42.5, "satellites": 8 }
}
```

An event record should use the dashboard event fields: `event_id`, `type` (`accident`, `sos`, or `overspeed`), `status`, `severity`, `timestamp`, `latitude`, `longitude`, `speed_kmh`, and, for crashes, `crash_speed_kmh`, `deceleration_mps2`, `crash_snapshot`, and `sensor_history`. Include the last valid crash coordinates and evidence samples in the event object so every signed-in dashboard can display the same evidence package. The ESP32 remains responsible for detecting crashes, calculating the device's actual sensor values, and running the 15-second countdown.

## 4. Publish the site

Install the Firebase command-line tools, sign in, select the project you created, then from this folder run:

```sh
firebase deploy --only hosting,database
```

The Hosting site will have a public HTTPS address, so it can be opened from other devices and networks. This folder's `firebase.json` excludes the Node server, local account files, backups, and setup notes from the hosted site. Local development still uses `npm start` at `http://localhost:8080`.

## Current implementation status

The hosted website is configured to listen to Firebase paths `vehicles/vehicle_01/latest` and `vehicles/vehicle_01/events`. A starter sketch is available in `firmware/esp32_vtaas/esp32_vtaas.ino`; it reads MPU-6050 and GPS data and writes the `latest` path. It still needs private Wi-Fi/device credentials, a trusted CA certificate, and validation with the physical modules. Accident detection, event writes, countdown, SOS/cancel buttons, and SIM800L messaging are not implemented in that starter yet.
