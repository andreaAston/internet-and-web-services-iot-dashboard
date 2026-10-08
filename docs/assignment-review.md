# IoT assignment review

Reviewed against `IoT_Assignment_2026 (1).docx` on 3 October 2026. The portfolio PDF does not apply.

## Coverage

| Requirement | Repository status |
| --- | --- |
| Node.js, Express, EJS and JSON ingestion | Implemented in the backend and page routes. |
| PostgreSQL persistent storage | Eight expected tables found in the configured database; integration tests exercise reads and writes. |
| Authenticated REST API | JWT for dashboard reads; hashed per-device API keys for writes. Passwords use bcrypt and SQL values are parameterized. |
| HTML, CSS, jQuery, EJS, live charts | Implemented; responsive CSS, Chart.js history, and five-second polling. |
| Device list and historical data | All registered devices are listed. History offers 1/6/24-hour views of up to the newest 1,000 records. |
| Fault resilience | Bad JSON/types rejected; null sensor values accepted without clearing alerts; frontend retries failed polling. Device timeout and recovery are covered by integration checks. Physical unplug/restart demo still required. |
| API documentation | `openapi.json` documents the REST endpoints with request/response examples. Browser routes are described in the backend README. |
| Three sensors and JSON transmission | Not verified: no device firmware, wiring, sensor inventory, or hardware evidence in this repository. |
| Team roles, commits and viva | Team names/contributions, presentation, and live evidence are still needed. This local repository had no commits at review time; remote history was not checked. |

## Simplification decisions

Use one database-driven device selection page and one dashboard instead of fixed Actual/Simulated Room branches. Remove the separate simulated-device setup; register additional devices with the same setup command. A fully simulated device must not be presented as meeting the hardware requirement: the brief permits at most one justified simulated sensor.

Keep the small Express route modules, direct SQL queries, existing schema, and jQuery polling. No ORM, service layer, WebSocket server, job queue, or new dependencies are needed. Current database records are preserved; no migration or table removal is necessary.

Keep access logs, users/cards, camera snapshots and environmental alerts because they form the existing Smart Access Monitor project. RFID and camera hardware may contribute to the sensor inventory, but this must be evidenced by the team. A fan is an actuator; temperature and humidity values from one combined module do not alone prove two separate sensors. Confirm at least three actual sensor devices with the lecturer's interpretation of the brief.

Use JSON `null` when a sensor read fails. This preserves the working sensors' values and shows unavailable readings on the dashboard. Device online means communication is active; it does not mean every sensor is healthy. Alerts remain active until a known normal reading arrives. Malformed strings, omitted fields and invalid ranges still return 400.

## Remaining submission evidence

1. Add the actual device firmware, sensor models, wiring/pin assignments and run instructions. Explain any one simulated sensor and its justification.
2. Run the full hardware-to-dashboard pipeline. Demonstrate a sensor unplug, a malformed payload, and a backend restart. Verify continued readings/recovery and PostgreSQL persistence.
3. Add team members and actual roles, meaningful commits (at least five per member), and the presentation. Preserve real work history rather than manufacturing earlier commits.
4. Confirm GitHub submission and the requested final-submission tag with the team. The brief gives 7 October 2026, 23:59 for submission and 9 October for the viva.
5. Review library/image/AI attribution and ensure every member can explain and modify their contribution.

## Manual resilience demonstration

Review checks passed: JavaScript syntax; PostgreSQL/HTTP integration covering authentication, telemetry validation, null readings, alert deduplication/resolution, history, uploads, device timeout/recovery, and HTTP listener restart. Browser checks covered login, database-driven device navigation, the history range control, and desktop/mobile layouts (390px mobile). No browser warning/error messages were captured during these checks. This is not a substitute for a physical hardware demo or a full process/database outage test.

- Send a valid authenticated telemetry packet, then send malformed JSON: expect 400. Send another valid packet: expect success and a new chart point.
- Disconnect one sensor and make the Pi send `null` for that sensor while continuing to send the others. Its KPI should show unavailable; other readings should continue.
- Stop telemetry for over two minutes: the device should show offline and identify its readings as last known. Resume telemetry: it should return online.
- Restart Express using the same database and JWT secret. The browser should retry, historical readings should remain, and the Pi must resume sending. Firmware retry behaviour cannot be verified until that code is supplied.
