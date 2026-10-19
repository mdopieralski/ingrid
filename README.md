# ingrid

[![Tests](https://github.com/mdopieralski/ingrid/actions/workflows/ci.yml/badge.svg)](https://github.com/mdopieralski/ingrid/actions/workflows/ci.yml)

Driving-route lookup service — give it one source and any number of destinations, get back the driving time and distance to each, fastest first.

**First feature: Routes.** `GET /routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=13.428555,52.523219` asks [OSRM](https://project-osrm.org/) for every source → destination pair in parallel and returns them sorted by duration, then distance.

---

## Quick start

Prerequisites: Node 22.15.1 (`nvm use`), pnpm 10.22.0. `pnpm install` brings in [Portless](https://github.com/vercel-labs/portless) as a dev dependency.

```sh
nvm use
pnpm install
cp .env.example .env
pnpm start:dev
```

`start:dev` runs the server through Portless, which gives it a stable HTTPS hostname instead of a port: the API is at **https://ingrid.local** and the Swagger docs at **https://ingrid.local/docs**. Portless picks a free port (4000–4999) and passes it in as `PORT`; `portless list` shows it. On first use it asks for `sudo` to start its proxy on port 443 and trust its local certificate. `--lan` makes the name reachable from other devices on the same Wi-Fi too. If a crashed process still holds the name, add `--force` to the `portless run` call. To skip Portless for one run: `PORTLESS=0 pnpm start:dev` (plain `http://localhost:3000`).

Then try it — three requests, expected output below each:

```sh
# Happy path: two destinations, fastest first
curl -s "https://ingrid.local/routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=13.428555,52.523219"
# 200 {"source":"13.388860,52.517037","routes":[{"destination":"13.397634,52.529407","duration":260.4,"distance":1888},{"destination":"13.428555,52.523219","duration":388.6,"distance":3800.9}]}

# Missing src: rejected before OSRM is called
curl -s "https://ingrid.local/routes?dst=13.397634,52.529407"
# 400 {"error":"Exactly one \"src\" parameter is required"}

# Unroutable destination (Svalbard has no road link): still 200
curl -s "https://ingrid.local/routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=15.6356,78.2232"
# 200 {"source":"13.388860,52.517037","routes":[{"destination":"13.397634,52.529407","duration":260.4,"distance":1888}],"unroutable":["15.6356,78.2232"]}
```

Durations come from the live demo server and can drift as its map data updates.

Or open **https://ingrid.local/docs** and use _Try it out_ in Swagger UI.

Full reset: `pnpm cache:clean && pnpm install && pnpm start:dev`.

---

## Table of content

1. [Quick start](#quick-start)
2. [Stack](#stack)
3. [Architecture](#architecture)
   - [Structure](#structure)
   - [API](#api)
   - [Behaviour decisions](#behaviour-decisions)
   - [Scripts](#scripts)
   - [Environment](#environment)
4. [Testing](#testing)
   - [CI](#ci)
   - [Not tested](#not-tested)
5. [License](#license)

---

## Stack

| App                                                  | Tools                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [Node.js](https://nodejs.org/docs/latest-v22.x/api/) | [pnpm](https://pnpm.io/)                                  |
| [TypeScript](https://www.typescriptlang.org/)        | [typescript-eslint](https://typescript-eslint.io/)        |
| [Express](https://expressjs.com/)                    | [ESLint](https://eslint.org/)                             |
| [OSRM](https://project-osrm.org/docs/v5.24.0/api/)   | [Prettier](https://prettier.io/)                          |
|                                                      | [Husky](https://typicode.github.io/husky/)                |
|                                                      | [Commitlint](https://commitlint.js.org/)                  |
|                                                      | [Lint-staged](https://github.com/lint-staged/lint-staged) |
|                                                      | [GitHub Actions](https://docs.github.com/actions)         |
| [Swagger UI](https://swagger.io/tools/swagger-ui/)   | [Portless](https://github.com/vercel-labs/portless)       |

Runtime: **Node 22.15.1** (`.nvmrc`). **TypeScript** (strict), ES modules. Dev mode uses Node's built-in `--watch` — no nodemon.

**How TypeScript runs.** One set of `.ts` files, two ways to run them:

- **Development and tests** run the `.ts` files directly, using Node's built-in type stripping (`--experimental-strip-types`). Nothing is compiled, and there is no loader dependency such as `tsx` or `ts-node`. On Node 22.15 the feature is behind a flag and prints an experimental warning, which the scripts silence with `--disable-warning=ExperimentalWarning`.
- **Production** runs plain JavaScript: `pnpm build` compiles `src/` to `dist/` with `tsc`, and `pnpm start` runs `dist/index.js`. No experimental flag runs in production.
- **Same code both ways:** `tsconfig.json` sets `erasableSyntaxOnly`, so the code uses only syntax Node can strip (no `enum`, no namespaces with runtime code, no parameter properties). Imports use `.ts` paths, which `tsc` rewrites to `.js` when it emits (`rewriteRelativeImportExtensions`).
- **Type-checking is a separate step:** type stripping removes types without checking them. `pnpm typecheck` (`tsc --noEmit`) checks `src/` and `test/`, and CI and the pre-push hook run it.

TypeScript is pinned to `~6.0`: typescript-eslint, which runs the type-aware lint rules, does not support TypeScript 6.1+ or the native TypeScript 7 yet. Dependabot is told to hold it there.

---

## Architecture

Single Express 5 app. Routes validate input and shape the response; anything that talks to the outside world lives in `src/services`; small pure helpers live in `src/utils`.

`index.ts` only starts the process; `app.ts` exports `createApp(options)`, so tests boot the whole app on a random port with injected config and no process-level state.

### Structure

```
src/
  index.ts               — process entry: reads env, starts the server
  app.ts                 — composition root: config, request context, routes, error handler
  routes/routes.ts       — GET /routes: validation, fan-out, sorting, RoutingError → status
  services/osrm.ts       — OSRM client: error taxonomy, retries, 4 s per attempt
  utils/coordinates.ts   — "lng,lat" parsing and range checks
  utils/concurrency.ts   — bounded parallel map (5 in flight)
  utils/logger.ts        — one JSON object per line
  docs/openapi.yaml      — OpenAPI 3.1 spec, the source of the API docs
  docs/docs.ts           — Swagger UI at /docs, the spec at /openapi.json

test/
  contract.test.ts       — A. contract & happy path
  validation.test.ts     — B. input validation
  upstream.test.ts       — C. upstream behaviour
  resilience.test.ts     — D. retries, concurrency, deadline
  operational.test.ts    — E. health, logs, cancellation
  docs.test.ts           — F. the spec matches real responses
  readme.test.ts         — the Scripts table below matches package.json
  integration.test.ts    — the one test against the real OSRM (skipped by default)
  fixtures/              — real OSRM payloads
  helpers/               — app and OSRM-stub boot

dist/                    — `pnpm build` output (git-ignored)

tsconfig.json            — type-check settings for src/ and test/ (no output)
tsconfig.build.json      — build settings: src/ → dist/

docs/
  RELEASE_MANAGER.md     — branch flow (feature → scope → release → main) and release checklist

.github/
  workflows/ci.yml          — Prettier, ESLint, typecheck, build, spec lint, tests, commit messages
  workflows/integration.yml — the live OSRM test, daily and on demand
  actions/setup/            — shared step: pnpm, Node from .nvmrc, cached install
  dependabot.yml            — weekly grouped updates for npm and actions

.husky/
  commit-msg             — Commitlint (Conventional Commits)
  pre-commit             — lint-staged: Prettier + ESLint --fix on staged files
  pre-push               — `pnpm standard` and `pnpm typecheck` over the whole repo
```

---

### API

Interactive docs: **[`/docs`](https://ingrid.local/docs)** (Swagger UI, with _Try it out_). The raw OpenAPI 3.1 spec is at `/openapi.json`; its source is `src/docs/openapi.yaml`. Its `info.version` is taken from `package.json`. Test group F sends real requests and checks every response against the spec's schemas, status codes, headers and example messages, so the docs fail CI when they drift from the code.

**Health**

| Method | Path      | Purpose                                                 |
| ------ | --------- | ------------------------------------------------------- |
| `GET`  | `/`       | service descriptor — what this is and where to go next. |
| `GET`  | `/health` | liveness — `{"status":"ok"}`.                           |

**Docs**

| Method | Path            | Purpose                        |
| ------ | --------------- | ------------------------------ |
| `GET`  | `/docs`         | Swagger UI.                    |
| `GET`  | `/openapi.json` | the OpenAPI 3.1 spec, as JSON. |

**Routes**

| Method | Path      | Purpose                                                                             |
| ------ | --------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/routes` | driving routes from one `src` to each `dst`; sorted by `duration`, then `distance`. |

Query parameters — coordinates are `longitude,latitude` (OSRM order):

- `src` — exactly one, required
- `dst` — 1 to 100, repeat the parameter for each destination

Coordinates are plain decimals (`13.38`, `-0.5`); hex, exponents and `Infinity` are rejected. The order is **lon,lat**: the brief's prose says "latitude and longitude", but its own example `13.388860,52.517037` is Berlin in lon,lat order, and OSRM is lon,lat. A swapped pair is usually still a legal coordinate (`52.517037,13.388860` is in Turkey), so it cannot be detected — it is a caller error.

Response — `duration` in seconds, `distance` in metres:

```json
{
  "source": "13.388860,52.517037",
  "routes": [
    { "destination": "13.397634,52.529407", "duration": 260.4, "distance": 1888 },
    { "destination": "13.428555,52.523219", "duration": 388.6, "distance": 3800.9 }
  ]
}
```

Destinations that no road reaches (OSRM `NoRoute` / `NoSegment`) are left out of `routes` and listed in `unroutable`. The key is present only when it is non-empty:

```json
{
  "source": "13.388860,52.517037",
  "routes": [{ "destination": "13.397634,52.529407", "duration": 260.4, "distance": 1888 }],
  "unroutable": ["15.6356,78.2232"]
}
```

Errors return `{ "error": "<message>" }`. Messages are fixed strings; upstream detail goes to the logs only.

| Status | When                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `src` missing or repeated, no `dst`, more than 100 `dst`, malformed or out-of-range coordinate                               |
| `502`  | OSRM unreachable (refused, DNS), answered 5xx after a retry, or sent an unusable body                                        |
| `503`  | OSRM rate-limited us (429); its `Retry-After` is passed through when present                                                 |
| `504`  | the 10 s request deadline passed before every destination was routed                                                         |
| `500`  | OSRM rejected our request (`InvalidQuery`, `InvalidUrl`, …) — a bug on our side, logged as an error — or anything unexpected |

Every response carries `X-Request-Id` (the caller's own, if sent).

> [!NOTE]
> OSRM snaps every point to the nearest road, so most off-road coordinates still return a route; `unroutable` is for pairs with no road between them (e.g. Berlin → Svalbard). The public demo server is rate-limited and not meant for production — point `OSRM_URL` at your own instance.

---

### Behaviour decisions

- **Partial failure fails the whole request.** If any destination fails (after its retry), the response is a single 5xx. A "fastest first" list with one destination silently missing is a wrong answer that looks right; the caller can retry instead. Unroutable destinations are not failures — they are a valid answer.
- **NoRoute/NoSegment come back as HTTP 400 from OSRM**, so the client reads OSRM's `code` before the HTTP status.
- **Retries:** one retry (2 attempts) for transient failures only — 5xx, timeout, connection error. No retry for 4xx, 429 (retrying makes a rate limit worse) or a malformed body.
- **Deadlines:** 4 s per OSRM call, 10 s for the whole request. The deadline is shared by all destinations and retries; when it passes, in-flight calls are aborted and no new attempt starts. The first failure, or a client disconnect, aborts the rest too. With 5 calls in flight, 100 destinations is 20 waves inside that 10 s budget — so the cap is 100, but the deadline is the real limit, and past roughly 25 destinations the answer is `/table`, not a longer deadline.
- **Fan-out:** one `/route` call per destination, at most 5 in flight per request. `/table?sources=0&annotations=duration,distance` would be one round-trip and one rate-limit slot, but it fails all-or-nothing and needs a second call path anyway; per-pair `/route` keeps failures and retries per destination. With 100 destinations, `/table` is the better choice — that is the switch to make when load demands it.
- **Duplicates:** a repeated `dst` is routed once and listed once.
- **Logs:** one JSON line per request (`requestId`, `path`, `status`, `durationMs`, `destinationCount`, `upstreamLatencyMs`, `outcome`), plus one line per upstream failure with its detail. Coordinates are customer addresses, so the query string and coordinates are never logged.

---

### Scripts

Everyday commands from `package.json` — `pnpm run` is authoritative.

| Name                                      | Description                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `start:dev`                               | Dev server at `https://ingrid.local` (API) and `/docs` (Swagger) via Portless; restarts on any change under `src/` |
| `build`                                   | Compile `src/` to `dist/` with `tsc` and copy `openapi.yaml` next to the compiled docs module                      |
| `start`                                   | Production start: `node dist/index.js` (run `build` first), `.env` loaded, no watch — `http://localhost:3000`      |
| `typecheck`                               | `tsc --noEmit` over `src/` and `test/`; Node's type stripping does not check types, this does                      |
| `test`                                    | Every test file, offline, against a local OSRM stub; the integration test is skipped                               |
| `test:ci`                                 | Same tests as `test`, printing readable output and writing JUnit results to `junit.xml` (used by CI)               |
| `test:integration`                        | The one test that calls the real OSRM (`OSRM_URL` or the public demo server)                                       |
| `cache:clean`                             | Remove `node_modules`; run `pnpm install` afterwards                                                               |
| `standard` / `standard:fix`               | Prettier + ESLint — check or apply                                                                                 |
| `standard:format` / `standard:format:fix` | Prettier only — check or apply                                                                                     |
| `standard:lint` / `standard:lint:fix`     | ESLint (with type-aware typescript-eslint rules) only — check or apply                                             |
| `docs:lint`                               | Lint `src/docs/openapi.yaml` with Redocly (rules in `redocly.yaml`)                                                |
| `commitlint`                              | Lint the commit message (run by the `commit-msg` hook)                                                             |
| `prepare`                                 | Install the Husky git hooks (runs automatically on `pnpm install`)                                                 |

Git hooks (Husky) run on every commit and push:

- `commit-msg` — the message must follow [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(routes): sort by distance on equal duration`
- `pre-commit` — lint-staged formats and lint-fixes staged files; a remaining ESLint error blocks the commit
- `pre-push` — `pnpm standard` and `pnpm typecheck`; skip with `git push --no-verify` when you've checked manually

---

### Environment

Copy `.env.example` → `.env`. Both `start` and `start:dev` load it if present (`--env-file-if-exists`). Never commit `.env`.

- Server
  - `PORT` — optional; default `3000`. Ignored under `start:dev`: Portless sets it, and a variable already set wins over `.env`
- Routing
  - `OSRM_URL` — optional; default `http://router.project-osrm.org` (no trailing slash)

---

## Testing

```sh
pnpm test               # offline, no secrets, ~1–2 s
pnpm test:integration   # one request against the real OSRM
```

Built on `node:test`; the only test dependency is `ajv`, which group F uses to validate responses against the OpenAPI spec. Every test except the integration one runs against a local HTTP server standing in for OSRM, not the public demo instance: that instance is rate-limited and shared, so a suite hitting it would be flaky by design. The stub replies with real OSRM payloads (`test/fixtures/`), and it counts calls and in-flight requests, so tests can check retries and concurrency.

| File                  | Group                    | Proves                                                                        |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `contract.test.ts`    | A. Contract & happy path | exact body shape, duration-then-distance sort, client coordinates echoed back |
| `validation.test.ts`  | B. Input validation      | each bad input → 400 **and** zero OSRM calls; the 100-destination cap         |
| `upstream.test.ts`    | C. Upstream behaviour    | every OSRM failure → the right status; nothing about OSRM leaks to the client |
| `resilience.test.ts`  | D. Resilience            | retry counts, bounded attempts, concurrency cap, per-request deadline         |
| `operational.test.ts` | E. Operational surface   | `/health` is offline, one structured log line, no coordinates in logs, cancel |
| `docs.test.ts`        | F. API docs              | every real response matches the spec: schemas, statuses, headers, messages    |
| `readme.test.ts`      | README                   | every `package.json` script is in the Scripts table, and nothing else is      |
| `integration.test.ts` | live contract (skipped)  | the brief's request works against the real OSRM                               |

### CI

The Husky hooks run these checks locally, but a hook can be skipped with `--no-verify`. CI is the gate that cannot be skipped. `.github/workflows/ci.yml` runs on every push to `main`, every pull request and on demand. It uses the Node version from `.nvmrc` and the lockfile as-is (`--frozen-lockfile`). Each check is its own job and they run in parallel, so the PR shows which one broke:

| Job               | Runs                                         | Notes                                                          |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `Prettier`        | `pnpm standard:format`                       |                                                                |
| `ESLint`          | `pnpm standard:lint`                         | errors are annotated inline on the PR diff                     |
| `Typecheck`       | `pnpm typecheck`                             |                                                                |
| `Build`           | `pnpm build`, then start `dist/` and call it | catches what type-checking cannot: a file missing from `dist/` |
| `OpenAPI spec`    | `pnpm docs:lint`                             |                                                                |
| `Tests`           | `pnpm test:ci`                               | JUnit report kept as the `junit-report` artifact, 14 days      |
| `Commit messages` | `commitlint` over the PR's commits           | PRs only; skipped for Dependabot                               |
| `CI passed`       | fails if any job above failed or stopped     | **the one check to mark required in branch protection**        |

- **Reproduce locally:** every job is one `pnpm` script, so a failure can be reproduced with the same command.
- **Superseded runs:** a new push to a PR cancels that PR's run already in progress. Runs on `main` always finish.
- **Pinned actions:** actions are pinned to commit SHAs. Dependabot (`.github/dependabot.yml`) bumps them and the npm packages weekly, in grouped PRs, and only for releases at least 7 days old.
- **Live OSRM test:** CI never calls the real OSRM, so a PR cannot fail because the shared demo server is slow. `.github/workflows/integration.yml` runs `pnpm test:integration` daily, and on demand with an optional `OSRM_URL`. That catches OSRM changing its contract. GitHub emails the workflow owner when a scheduled run fails.

**One-time setup on GitHub:**

1. Under _Settings → Branches_, add a protection rule for `main` and require the `CI passed` check.
2. Under _Settings → Code security_, enable Dependabot version updates.

### Not tested

- **Load / high traffic:** not measured. Next steps would be a per-instance cap on concurrent OSRM calls (not just per request) and a circuit breaker around the OSRM client that fails fast with 503 once the error rate crosses a threshold.
- **Caching:** not implemented. Pickup-point lookups repeat the same src+dst pairs heavily; a TTL cache keyed on the coordinate pair rounded to ~5 decimals (≈1 m), expiring by time only, would remove most upstream calls.
- **Self-hosted OSRM:** the demo server is not for production. Running our own means building the graph from an OSM extract (hours and tens of GB of RAM for Europe), re-running that on every map refresh, and running ≥2 instances behind a load balancer.
- **Observability stack:** counters worth exporting — requests by `outcome`, upstream latency histogram, upstream attempts and retries, unroutable count. The log lines carry these fields today; nothing collects them.
- **Client cancellation:** supported. A client disconnect aborts in-flight OSRM calls and stops new attempts (test E5), so a dropped request does not keep using the shared rate limit.
- **Continuous delivery:** CI verifies every push; there is no deploy step. The same workflow would build a container image, push it to a registry on a tagged commit and roll out behind a health check — `/health` is already the probe it would use.
- **Authentication and rate limiting:** none. The service is public, has no API key and no request budget of its own, while a single request fans out to as many as 100 upstream calls. The cap of 5 concurrent OSRM calls is per request, so it does nothing against 100 concurrent callers: one abusive client can exhaust the shared OSRM quota for everyone else. In production: an API key or mTLS at the gateway, a per-client request budget, and a global in-flight cap on OSRM calls rather than a per-request one.
- **Docs served by the service:** the API docs come from the app itself, so `swagger-ui-dist` is a production dependency and a few megabytes of static assets ship with the service, publicly. In production the docs would sit behind a flag or on a separate host, with the spec published from CI instead of served by the API.
- **`/ready`:** not implemented. `/health` is liveness only and never calls OSRM; a readiness check that does would need its own short timeout and caching so probes do not use up the rate limit.

---

## License

Private and unlicensed. All rights reserved.
