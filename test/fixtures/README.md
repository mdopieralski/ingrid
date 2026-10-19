# OSRM fixtures

Real responses from `router.project-osrm.org`, captured 2026-10-19 and saved unedited. Tests that need other numbers clone `route-ok.json` and change only `duration`/`distance` (see `test/helpers/fixtures.ts`).

| File                         | Request (`/route/v1/driving/…?overview=false`)               | HTTP |
| ---------------------------- | ------------------------------------------------------------ | ---- |
| `route-ok.json`              | `13.388860,52.517037;13.397634,52.529407`                    | 200  |
| `route-ok-2.json`            | `13.388860,52.517037;13.428555,52.523219`                    | 200  |
| `route-no-route.json`        | `13.388860,52.517037;15.6356,78.2232` (Berlin → Svalbard)    | 400  |
| `route-no-segment.json`      | `13.388860,52.517037;-30.0,0.0` with `radiuses=unlimited;10` | 400  |
| `route-invalid-query.json`   | `13.388860,52.517037;abc,def`                                | 400  |
| `route-invalid-options.json` | `13.388860,52.517037` (one coordinate)                       | 400  |

OSRM reports `NoRoute` and `NoSegment` with **HTTP 400**, not 200. The client therefore reads `code` before the HTTP status.

`distance` is often an integer (`1888`), so the JSON has no decimal point.
