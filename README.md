# OpenQuatt for Homey

Homey Pro app that connects to an [OpenQuatt](https://github.com/OpenQuatt/OpenQuatt) heat pump controller on the local network.

## How it works

The app talks to the ESPHome web server that OpenQuatt already runs on port 80:

- **State**: a persistent Server-Sent Events stream on `GET /events`. Every entity state is pushed on connect and again on every change, so updates are real-time without polling.
- **Commands**: the REST routes, addressed by URL-encoded *display name* (`POST /switch/Manual%20Cooling%20Enable/turn_on`). POSTs need an explicit `Content-Length: 0` header. These routes also reach `internal: true` entities such as the aux relay function select.

No API encryption key is required and there are **zero runtime npm dependencies**.

## Current feature set (v0.1)

Device (paired via mDNS discovery of `_esphomelib._tcp`, with a manual IP override in the device settings):

| Capability | OpenQuatt entity |
|---|---|
| Supply / outside / room temperature | `*_(selected)` sensors |
| Power | `Total Power Input` |
| Control mode | `Control Mode (label)` |
| Manual cooling enable (toggle) | `Manual Cooling Enable` |
| Aux relay R2 (toggle) | `Aux relay (R2)` — only effective in External control |

Flow cards:

- **Triggers**: control mode changed (token: mode code), cooling started, cooling stopped
- **Conditions**: is cooling, is heating (CM2/CM3/CM4)
- **Actions**: set manual cooling enable, set aux relay function, set aux relay (R2)

## Development

```bash
npm i -g homey        # Athom CLI
homey login
homey app validate
homey app run         # pick your Homey Pro, live-reloads on save
```

`homey app run` installs the app in development mode on the Homey you select and streams its log output to the terminal.

## Extending

- Entity → capability wiring lives in `drivers/openquatt/device.js` (`ENTITY_CAPABILITIES`). Add a line + the capability in `driver.compose.json` and it shows up.
- The transport lives in `lib/OpenQuattClient.js`. A native-API transport (port 6053) could be added later behind the same interface.
- Keep the connection count low: OpenQuatt is heap-constrained on the ESP32; one persistent SSE client is fine, several are not.
