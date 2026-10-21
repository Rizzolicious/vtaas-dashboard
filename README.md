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

Firebase Authentication and Realtime Database listeners, along with Firebase Hosting configuration, are included. The current project configuration points to the `vt-aas` Firebase project. Follow [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for the database paths and access rules. This repository contains the dashboard, Cloudflare Workers WebSocket relay, and a real-hardware ESP32 WebSocket firmware sketch in [`firmware/ESP32_VTAAS_Real`](firmware/ESP32_VTAAS_Real). The firmware compiles for NodeMCU-32S; physical upload and end-to-end hardware validation are not yet verified.

## Real hardware firmware

The [`firmware/ESP32_VTAAS_Real`](firmware/ESP32_VTAAS_Real) sketch reads MPU6050 motion data and NEO-6M GPS, controls the status LEDs and GPIO19 buzzer, and submits incident SMS through SIM800L. It publishes measured telemetry through the authenticated Cloudflare WebSocket relay. See [`firmware/README.md`](firmware/README.md) for the pin map, dependencies, setup, and prototype limitations. Copy `config.example.h` to a local `config.h` and enter credentials there; local config files are ignored by Git.

## Accounts

The hosted website uses Firebase Authentication. The included Node server is for local development and fallback mode. Do not expose it to the public internet.

## Connect the ESP32 over Wi-Fi

The synopsis calls for Wi-Fi data transmission but does not specify a cloud service or message protocol. This folder includes a small LAN relay so the ESP32 can POST JSON or send WebSocket text frames and the browser can receive them live:

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

- **MQTT:** The dashboard subscribes through EMQX's secure MQTT-over-WebSocket listener; the ESP32 should use MQTT over TLS/TCP. The device and dashboard use separate authorized credentials. MQTT.js is loaded from a CDN, so the browser needs internet access. Credentials are held only in the page session.
- **WebSocket:** The dashboard connects to the hosted Cloudflare Worker using secure WebSocket (WSS). The dashboard signs in with Firebase; the ESP32 authenticates with the `DEVICE_WS_TOKEN` secret configured in Cloudflare and in the private firmware `secrets.h`. After authentication, the device sends one telemetry JSON object per text frame; the relay forwards it to signed-in dashboard clients for `vehicle_01`. The relay keeps no telemetry history. The local Node server's `/ws` endpoint remains available for LAN testing.
- **Bluetooth LE:** The browser requests a BLE device and subscribes to a GATT notify characteristic. The default UUIDs are the Nordic UART Service; change them to match the ESP32 firmware. Notifications must contain newline-delimited JSON. Bluetooth Classic is not supported by Web Bluetooth, and this browser feature requires a supported browser on HTTPS or localhost.

## Event history and measurements

## Protocol comparison

The dashboard does not generate or score a simulated protocol benchmark. To compare the real transports manually, send the same ESP32 sensor payload and sampling interval through MQTT and WebSocket. View each stream in a separate dashboard tab, selecting MQTT in one and WebSocket in the other, and record delivery, latency, and reconnect behavior during controlled runs. Do not present simulator data as hardware results.

### Cloudflare WebSocket relay

The relay source and its deployment configuration are in `cloudflare/`. It uses a SQLite-backed Durable Object for WSS connections. Deploy it with Wrangler using `npx wrangler deploy --config cloudflare/wrangler.jsonc`, then add a secret named `DEVICE_WS_TOKEN` using Wrangler's secret command. Never put the device token in `vars`, commit it, or send it in a public message. Use the resulting `wss://<worker-name>.<account>.workers.dev/ws` URL in **Protocols → WebSocket**. The dashboard requires a VT&AAS Firebase sign-in; the ESP32 sends an auth frame first, then telemetry frames. See `cloudflare/README.md` for the device frame format and deployment steps.

Cloudflare's free tier has daily limits. If the quota is reached, relay activity can fail until the limit resets. For local tests, the Node server's `ws://<computer-ip>:8080/ws` endpoint remains available on a trusted LAN.

## Project notes

- Incident detection, severity logic, buzzer, countdown, cancellation, SOS and GSM SMS belong in ESP32 firmware.
- This dashboard is the monitoring interface. It does not replace the device's safety behavior.
- The map uses OpenStreetMap in an embedded frame and needs internet access. A valid vehicle coordinate is included in the map URL sent to OpenStreetMap; coordinates and a map link remain available without tiles.
- The BLE, MQTT and custom WebSocket details must match the firmware or gateway. The provided synopsis does not include endpoint, topic, GATT UUID, sensor calibration, SMS status field, or exact data protocol.
