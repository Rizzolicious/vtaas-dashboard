# Cloudflare WebSocket relay

This Worker exposes `GET /healthz` and the secure WebSocket endpoint `/ws`. It forwards live device JSON frames to signed-in VT&AAS dashboard sessions for `vehicle_01`. It also supports the existing marked browser demo packets for local testing. It does not store telemetry or replace the Firebase incident history.

## Deploy

1. Sign in to Cloudflare and create a free Workers account if you do not already have one.
2. From the project root, run `npx wrangler@3.114.14 login` and approve the browser sign-in (this version works with the project's current Node 20 installation).
3. Run `npx wrangler@3.114.14 deploy --config cloudflare/wrangler.jsonc`.
4. Create a long random device token locally. Set it as a Worker secret with `npx wrangler@3.114.14 secret put DEVICE_WS_TOKEN --config cloudflare/wrangler.jsonc` (paste the token at the prompt). Keep a private copy for the ESP32 `secrets.h`; never commit it or put it in `vars`.
5. The dashboard endpoint is `wss://vtaas-ws-relay.<your-workers-subdomain>.workers.dev/ws`. Enter it in **Protocols → WebSocket** while signed in to VT&AAS.

The free Durable Objects plan uses SQLite-backed objects. The relay uses the WebSocket hibernation API, and the free plan has daily request and active-compute quotas. If a quota is exceeded, requests can fail until the quota resets.

## ESP32 connection contract

The device opens a TLS WebSocket to `/ws`, validates the server certificate, and sends this first text frame:

```json
{"type":"auth","role":"device","token":"<DEVICE_WS_TOKEN>"}
```

Wait for `{"type":"auth_ok","vehicle_id":"vehicle_01"}` before sending telemetry. After that, send one JSON object per text frame, using the shared payload format in the project README. The Worker adds `device_id: "vehicle_01"` if the payload omits it and forwards the frame to signed-in dashboard clients. The device must reconnect and authenticate again after a disconnect.

Use a separate EMQX username/password for MQTT and the shared Worker token for WebSocket. Keep both secrets out of source control. For a fair manual comparison, send the same measured readings and sampling interval over both transports; the dashboard does not calculate or fabricate benchmark results.

## Dashboard authentication

The dashboard sends its Firebase ID token in an auth frame with `role: "dashboard"`. The Worker verifies the token signature and project claims against Google's published Firebase signing certificates before allowing telemetry to reach that dashboard connection. Dashboard WebSocket connections are read-only.

## Local relay

For local development, use `node server.js` and connect the dashboard or ESP32 to `ws://<computer-ip>:8080/ws`. The local server does not require the Cloudflare device token. Keep it on a trusted LAN and do not expose it to the public internet.
