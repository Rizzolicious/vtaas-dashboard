# VT&AAS real hardware firmware

This is the WebSocket firmware for the real ESP32 prototype. It reads an MPU6050 and NEO-6M GPS, drives the LEDs and active buzzer, uses a SIM800L to submit an SMS after the accident countdown, and sends measured JSON telemetry through the authenticated Cloudflare WebSocket relay. `simulation` and `test_mode` are both `false`; missing sensor or location data is reported as unavailable.

## Wiring

| Part | ESP32 connection |
|---|---|
| MPU6050 SDA / SCL | GPIO 21 / GPIO 22 |
| NEO-6M TX / RX | GPIO 16 / GPIO 17 |
| SIM800L TXD / RXD | GPIO 27 / GPIO 26 |
| Red LED / green LED | GPIO 4 / GPIO 18, each through a 220–330 ohm resistor |
| Active buzzer or suitable driver input | GPIO 19 |
| All grounds | Common GND |

Power the SIM800L from a supply suitable for its board and capable of short high-current bursts. Do not feed 5 V into a bare SIM800L module. The ESP32 and module must share ground. The final guide’s SIM wiring is RX27/TX26; it differs from the earlier standalone UART test.

## Build and upload

1. Open the `ESP32_VTAAS_Real` folder as an Arduino sketch and install/select ESP32 board support.
2. Install ArduinoJson 7 and WebSocketsClient. Select **NodeMCU-32S** and the correct USB serial port.
3. Copy `config.example.h` to `config.h` beside the sketch. Enter the 2.4 GHz hotspot name/password, Cloudflare device token, and SMS recipient in `config.h`. Keep that file private.
4. Upload. Open Serial Monitor at 115200 baud. Keep the IMU still for its startup calibration. `STATUS` prints connection/sensor state. Type `CANCEL` within the countdown to cancel; type `SOS` to queue a manual SMS test.
5. Give the GPS antenna a clear view of the sky. An indoor or unregistered GPS reports no fix. Check the SIM card, antenna, supported cellular bands, registration, and modem supply if SMS is unavailable.

## What the prototype measures

- MPU6050 acceleration and angular rate; startup stationary baseline; impact event when the change from that baseline exceeds 2.7 g in consecutive samples.
- NEO-6M RMC/GGA fix, position, ground speed, satellite count, and HDOP when valid.
- SIM800L SIM readiness and network registration; SMS submission result. A modem `+CMGS` response confirms network submission only, not delivery to the recipient.
- 15-second cancellation countdown and GPIO alarm outputs. Cancellation/SOS commands are entered in Serial Monitor; the supplied wiring has no physical button input.

The impact threshold is a prototype setting, not a validated crash classifier. Mount the MPU6050 rigidly and orient its X axis along the vehicle for the forward-axis deceleration estimate. Real roads and vehicle mounting require controlled calibration and validation; this code is for an academic prototype and must not be used as a certified safety system.

## Professor-facing source copy

The accompanying ZIP contains only the sketch, public TLS root certificate, example configuration, and this guide. It contains no hotspot password, relay token, or private `config.h`. Add your local configuration separately before building.
