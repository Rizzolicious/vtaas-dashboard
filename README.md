# VT&AAS ESP32 Dashboard

A browser dashboard for the vehicle tracking and accident alert project. It includes a working demo stream, live GPS and sensor displays, accident/SOS/overspeed event history, and adapters for WebSocket, MQTT over WebSocket, and BLE notifications.

## Start it

Install Node.js, then from this folder:

```sh
npm install
npm start
```

Open `http://localhost:8080`. On first launch, create an account, then sign in. The dashboard starts in demo mode and needs no ESP32 to explore. The demo uses clearly simulated GPS and sensor readings; they are not a live location or benchmark result.

## Cloud deployment

Firebase Authentication and Realtime Database listeners, along with Firebase Hosting configuration, are included. The current project configuration points to the `vt-aas` Firebase project. Follow [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for the database paths and access rules. An initial ESP32 telemetry sketch is in [firmware/esp32_vtaas/esp32_vtaas.ino](firmware/esp32_vtaas/esp32_vtaas.ino); it is not yet validated against physical hardware.

## Accounts

The hosted website uses Firebase Authentication. The included Node server is for local development and fallback mode. Do not expose it to the public internet.

## ESP32 firmware starter

Open [firmware/README.md](firmware/README.md) for Arduino IDE setup, the schematic-derived pin map, and private credential setup. The starter reads MPU-6050 and GPS telemetry and writes the latest sample to the Firebase path watched by the dashboard. Crash detection, countdown, buttons, and SIM800L alerts still need implementation and physical calibration.

## Connect the ESP32 over Wi-Fi

The synopsis calls for Wi-Fi data transmission but does not specify a cloud service or message protocol. This folder includes a small LAN relay so the ESP32 can POST JSON and the browser can receive it live:

1. Connect the computer running this server and the ESP32 to the same Wi-Fi network.
2. Find the computer's local IP address.
3. In the dashboard, open **Protocols → WebSocket** and connect to `ws://<computer-ip>:8080/ws`.
4. Configure firmware to POST each telemetry JSON object to `http://<computer-ip>:8080/api/telemetry` with `Content-Type: application/json`.

The relay forwards each accepted object to connected dashboard tabs. Alternatively, firmware or a gateway may open a WebSocket to `ws://<computer-ip>:8080/ws` and send JSON text frames; the relay forwards those to the other connected tabs.

The dashboard requires an account, but the ESP32 telemetry ingest endpoint remains unauthenticated so the firmware can send readings without a browser session. Keep the server on a trusted private network and do not expose its port publicly. The SMS path remains the ESP32/SIM800L responsibility; the dashboard only displays delivery state if firmware reports it.

## Shared JSON payload

Send one JSON object per HTTP request, WebSocket text frame, MQTT message, or newline-terminated BLE notification. These fields align with the project synopsis and the expanded dashboard brief:

```json
{
  "device_id": "vehicle_01",
  "event_id": "evt_0001",
  "message_type": "telemetry",
  "timestamp": "2026-10-12T08:30:00Z",
  "vehicle_status": "NORMAL",
  "accident_state": "NONE",
  "severity": "NONE",
  "countdown_remaining_s": 0,
  "speed_limit_kmh": 80,
  "battery_percent": 92,
  "wifi_rssi_dbm": -57,
  "acceleration": { "x": 0.12, "y": -0.08, "z": 9.72, "unit": "m/s2" },
  "gyroscope": { "x": 0.5, "y": -0.2, "z": 1.1, "unit": "deg/s" },
  "gps": {
    "valid": true,
    "latitude": 21.708444,
    "longitude": 72.995917,
    "speed_kmh": 48.52,
    "satellites": 8,
    "accuracy_m": 4.2,
    "hdop": 1.1
  }
}
```

Battery, Wi-Fi signal, GPS accuracy, and HDOP are optional. Omit them if the hardware does not measure them. For emergency delivery, include `sms_status` (or `delivery_status`) on incident updates with the exact state your firmware can confirm, such as `PENDING`, `SENT`, `DELIVERED`, `FAILED`, or `ACKNOWLEDGED`; the dashboard never invents a delivery result.

Supported accident states are `NONE`, `SUSPECTED`, `COUNTDOWN`, `CANCELLED`, `CONFIRMED`, `ALERT_SENT`, and `ACKNOWLEDGED`. A manual SOS can use `message_type: "manual_sos"` and `accident_state: "SOS"`. An overspeed event can use `message_type: "overspeed_alert"`, `speed_kmh`, and `speed_limit_kmh`. Include a stable `event_id` on every update of the same event; the dashboard updates that record instead of duplicating it.

The firmware is the source of truth for accident detection and the 15-second countdown. Include `countdown_remaining_s` in every suspected/countdown update so the screen follows the actual device. The dashboard does not send a cancel command to hardware.

The browser accepts `speed_kmh` at the top level or under `gps`. It uses units from the firmware payload, falling back to `m/s²` and `°/s` labels if no unit string is provided. Invalid or stale GPS is shown as unavailable; old coordinates are not presented as a current fix. Device health shows GPS accuracy/HDOP, battery, and Wi-Fi signal only when the firmware sends those fields.

## Other transports

- **MQTT:** Provide the broker's `ws://` or `wss://` listener URL and a telemetry topic/filter. The ESP32 can continue publishing over its normal MQTT/TCP connection. MQTT.js is loaded from a CDN, so the browser needs internet access for this mode. Broker credentials are held only in the page session.
- **Bluetooth LE:** The browser requests a BLE device and subscribes to a GATT notify characteristic. The default UUIDs are the Nordic UART Service; change them to match the ESP32 firmware. Notifications must contain newline-delimited JSON. Bluetooth Classic is not supported by Web Bluetooth, and this browser feature requires a supported browser on HTTPS or localhost.
- **WebSocket:** The dashboard listens for JSON text messages at the configured endpoint. The included relay exposes `/ws`; a custom ESP32 or gateway server can be used instead.

## Event history and measurements

## Demo MQTT and WebSocket comparison

Open **Protocols → Demo protocol comparison** and configure the MQTT broker under the MQTT tab. The demo generator sends the same simulated vehicle messages through both connections at the same interval. The comparison panel counts transmitted and returned packets, calculates delivery percentage, and shows average browser round-trip time. MQTT uses QoS 0 for the comparison.

The demo comparison uses the authenticated WebSocket relay in `cloud-relay.js`. To run it locally, start the dashboard with `npm start`, then in a second terminal run `node cloud-relay.js`. Set the comparison relay field to `ws://localhost:8081/ws`. Sign in to the dashboard with the VT&AAS Firebase account. Before connecting, the page explains that it sends a short-lived Firebase sign-in token to the relay for verification and sends the MQTT login to the configured broker. The relay only accepts marked simulated comparison messages, and it only echoes a run's messages between browser connections belonging to the same signed-in account.

`render.yaml` prepares a free Frankfurt Render web service for this comparison relay. The Firebase-hosted HTTPS page requires the relay's `wss://` URL. Render free services can sleep when idle, so the first connection after inactivity may need a retry. This relay is for the classroom protocol comparison only; it is not a production telemetry, crash-alert, or emergency-message path. The Firebase-hosted site must be redeployed after dashboard file changes.

These are demo-only browser-to-browser measurements, not ESP32 results. Simulated incident messages are marked and are excluded from the local relay's saved incident history. For the hardware comparison, run the same firmware payload and rate over MQTT and WebSocket and record results separately; the demo figures should not be presented as hardware performance.

Without Firebase configuration, event history is stored in browser local storage and the local WebSocket relay can keep a rolling buffer in `data/relay-events.json`. With Firebase configured, the dashboard reads shared incident history from Realtime Database. The ESP32 should queue events in its own flash/SD storage if it needs to retain them while the network is unavailable.

Use **Export CSV** for a spreadsheet copy. Open an event's **Evidence package** and choose **Save report as PDF** to open the browser print dialog, then select **Save as PDF**. The evidence view includes event delivery status only when the ESP32 reports it.

The Live sensors page includes a five-second stationary baseline capture for real telemetry. It stores a reference in this browser for inspection; it does not alter readings or send calibration/threshold commands to the ESP32. The dashboard severity bands are reference estimates only. The ESP32 firmware remains authoritative for crash detection and thresholds.

Latency and delivery ratio are left blank unless the incoming JSON contains measured benchmark fields, for example:

```json
"benchmark": { "latency_ms": 42, "sent_messages": 100, "received_messages": 98 }
```

Use synchronized clocks or a round-trip measurement for latency, and repeat protocol runs under comparable conditions before reporting results.

## Project notes

- Incident detection, severity logic, buzzer, countdown, cancellation, SOS and GSM SMS belong in ESP32 firmware.
- This dashboard is the monitoring interface. It does not replace the device's safety behavior.
- The map uses OpenStreetMap in an embedded frame and needs internet access. A valid vehicle coordinate is included in the map URL sent to OpenStreetMap; coordinates and a map link remain available without tiles.
- The BLE, MQTT and custom WebSocket details must match the firmware or gateway. The provided synopsis does not include endpoint, topic, GATT UUID, sensor calibration, SMS status field, or exact data protocol.
