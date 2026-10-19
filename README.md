<div align="center">

# ingrid

**Driving routes from one point to many, fastest first.**

Send one source and up to 100 destinations. Get the driving time and distance to each one, sorted.

[![CI](https://github.com/mdopieralski/ingrid/actions/workflows/ci.yml/badge.svg)](https://github.com/mdopieralski/ingrid/actions/workflows/ci.yml)
[![Live OSRM test](https://github.com/mdopieralski/ingrid/actions/workflows/integration.yml/badge.svg)](https://github.com/mdopieralski/ingrid/actions/workflows/integration.yml)
![Node 22](https://img.shields.io/badge/node-22.15-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Express 5](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1-6BA539?logo=openapiinitiative&logoColor=white)

[Quick start](#quick-start) · [API](#api) · [How it works](#how-it-works) · [Development](#development) · [Testing](#testing) · [Deployment](#deployment-vercel)

</div>

```sh
curl "https://ingrid.local/routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=13.428555,52.523219"
```

```json
{
  "source": "13.388860,52.517037",
  "routes": [
    { "destination": "13.397634,52.529407", "duration": 260.4, "distance": 1888 },
    { "destination": "13.428555,52.523219", "duration": 388.6, "distance": 3800.9 }
  ]
}
```

`duration` is in seconds, `distance` in metres. Routes come from [OSRM](https://project-osrm.org/), one call per destination, at most 5 in parallel.

---

## Contents

1. [Quick start](#quick-start)
2. [API](#api)
3. [How it works](#how-it-works)
4. [Project structure](#project-structure)
5. [Development](#development) — stack, TypeScript, environment, git hooks, scripts
6. [Testing](#testing) — test groups, CI
7. [Deployment (Vercel)](#deployment-vercel)
8. [Contributing and releases](#contributing-and-releases)
9. [Limitations and next steps](#limitations-and-next-steps)
10. [License](#license)

---

## Quick start

**You need:** Node 22.15.1 (`nvm use` reads `.nvmrc`) and pnpm 10.22.0.

```sh
nvm use
pnpm install
cp .env.example .env
pnpm start:dev
```

| What           | Where                             |
| -------------- | --------------------------------- |
| API            | https://ingrid.local              |
| Swagger UI     | https://ingrid.local/docs         |
| OpenAPI (JSON) | https://ingrid.local/openapi.json |

<details>
<summary><b>About <code>ingrid.local</code> (Portless)</b></summary>

<br>

`start:dev` runs the server through [Portless](https://github.com/vercel-labs/portless), a dev dependency that gives it a stable HTTPS name instead of a port number.

- Portless picks a free port (4000–4999) and passes it in as `PORT`. `portless list` shows which one.
- On first use it asks for `sudo`, to run its proxy on port 443 and trust its local certificate.
- `--lan` makes the name reachable from other devices on the same Wi-Fi.
- If a crashed process still holds the name, add `--force` to the `portless run` call in `package.json`.
- To skip Portless for one run: `PORTLESS=0 pnpm start:dev`. The server is then at `http://localhost:3000`.

</details>

### Try it

```sh
# Two destinations, fastest first
curl -s "https://ingrid.local/routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=13.428555,52.523219"
# 200 {"source":"13.388860,52.517037","routes":[{"destination":"13.397634,52.529407","duration":260.4,"distance":1888},{"destination":"13.428555,52.523219","duration":388.6,"distance":3800.9}]}

# Missing src: rejected before OSRM is called
curl -s "https://ingrid.local/routes?dst=13.397634,52.529407"
# 400 {"error":"Exactly one \"src\" parameter is required"}

# A destination no road reaches (Svalbard): still 200, listed under "unroutable"
curl -s "https://ingrid.local/routes?src=13.388860,52.517037&dst=13.397634,52.529407&dst=15.6356,78.2232"
# 200 {"source":"13.388860,52.517037","routes":[{"destination":"13.397634,52.529407","duration":260.4,"distance":1888}],"unroutable":["15.6356,78.2232"]}
```

Durations come from the public OSRM demo server and can change as its map data updates. You can also open **[/docs](https://ingrid.local/docs)** and use _Try it out_.

Something stuck? Full reset: `pnpm cache:clean && pnpm install && pnpm start:dev`.

---

## API

| Method | Path            | Purpose                                                                            |
| ------ | --------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/routes`       | Driving routes from one `src` to each `dst`, fastest first                         |
| `GET`  | `/health`       | Liveness: `{"status":"ok"}`. Never calls OSRM                                      |
| `GET`  | `/`             | Service descriptor: what this is and links to the endpoints below                  |
| `GET`  | `/docs`         | Swagger UI                                                                         |
| `GET`  | `/openapi.json` | The OpenAPI 3.1 spec. Source: `src/docs/openapi.yaml`; version from `package.json` |

The spec is checked against the code: test group F sends real requests and validates every response against the spec's schemas, statuses, headers and example messages. If the docs drift from the code, CI fails.

### `GET /routes`

| Parameter | Required | Count | Format                                           |
| --------- | -------- | ----- | ------------------------------------------------ |
| `src`     | yes      | 1     | `longitude,latitude`, e.g. `13.388860,52.517037` |
| `dst`     | yes      | 1–100 | same; repeat the parameter for each destination  |

> [!IMPORTANT]
> Coordinates are **longitude first**, as in OSRM. The brief's text says "latitude and longitude", but its own example `13.388860,52.517037` is Berlin in lon,lat order. A swapped pair is usually still a valid point (`52.517037,13.388860` is in Turkey), so the service cannot detect it.

Coordinates are plain decimals (`13.38`, `-0.5`). Hex, exponents and `Infinity` are rejected, as are values out of range.

**Response.** `routes` is sorted by `duration`, then `distance`. A destination that no road reaches (OSRM `NoRoute` / `NoSegment`) is left out of `routes` and listed in `unroutable`. That key appears only when it is not empty:

```json
{
  "source": "13.388860,52.517037",
  "routes": [{ "destination": "13.397634,52.529407", "duration": 260.4, "distance": 1888 }],
  "unroutable": ["15.6356,78.2232"]
}
```

**Errors** return `{ "error": "<message>" }`. Messages are fixed strings: details from OSRM go to the logs, never to the caller.

| Status | When                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------- |
| `400`  | `src` missing or repeated, no `dst`, more than 100 `dst`, a malformed or out-of-range coordinate   |
| `499`  | The client disconnected before the answer was ready (logged only; the client never sees it)        |
| `500`  | OSRM rejected our request (`InvalidQuery`, `InvalidUrl`, …): a bug on our side, logged as an error |
| `502`  | OSRM unreachable (refused, DNS), still 5xx after a retry, or sent a body we cannot use             |
| `503`  | OSRM rate-limited us (429). Its `Retry-After` header is passed through when present                |
| `504`  | The 10 s request deadline passed before every destination was routed                               |

Every response carries `X-Request-Id`: the caller's own if it sent a well-formed one, otherwise a new UUID.

> [!NOTE]
> OSRM snaps every point to the nearest road, so most off-road coordinates still get a route. `unroutable` is for pairs with no road between them, such as Berlin → Svalbard. The public demo server is rate-limited and not meant for production: point `OSRM_URL` at your own instance.

---

## How it works

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as GET /routes
  participant O as OSRM

  C->>R: src + dst × N
  R->>R: validate every coordinate (bad input → 400, OSRM never called)
  par at most 5 in flight
    R->>O: /route/v1/driving/src;dst₁
    O-->>R: duration, distance
  and
    R->>O: /route/v1/driving/src;dst₂
    O-->>R: NoRoute → unroutable
  end
  R->>R: sort by duration, then distance
  R-->>C: 200 { source, routes, unroutable? }
```

| Limit                    | Value | Why                                                              |
| ------------------------ | ----- | ---------------------------------------------------------------- |
| Destinations per request | 100   | Bounds the fan-out; the deadline is the real limit (see below)   |
| OSRM calls in flight     | 5     | Per request, so one request cannot use the whole OSRM rate limit |
| Time per OSRM attempt    | 4 s   | A slow call is retried once instead of using the whole budget    |
| Attempts per destination | 2     | One retry, for transient failures only                           |
| Deadline per request     | 10 s  | Shared by all destinations and retries                           |

### Behaviour decisions

- **One failure fails the whole request.** If any destination still fails after its retry, the response is a single 5xx. A "fastest first" list with one destination silently missing is a wrong answer that looks right; the caller can retry instead. Unroutable destinations are not failures: they are a valid answer.
- **OSRM sends `NoRoute` / `NoSegment` with HTTP 400**, so the client reads OSRM's `code` before the HTTP status.
- **Retries** happen only for transient failures: 5xx, timeout, connection error. There is no retry for 4xx, for 429 (retrying makes a rate limit worse), or for a malformed body.
- **Deadlines.** When the 10 s deadline passes, in-flight calls are aborted and no new attempt starts. The first failure, or a client disconnect, aborts the remaining calls too. With 5 calls in flight, 100 destinations is 20 waves inside 10 s, so past roughly 25 destinations the answer is OSRM's `/table`, not a longer deadline.
- **One `/route` call per destination**, not one `/table` call. `/table?sources=0&annotations=duration,distance` would be one round-trip and one rate-limit slot, but it fails all-or-nothing and needs a second code path anyway. Per-pair `/route` keeps failures and retries per destination. For requests near 100 destinations, `/table` is the switch to make when load demands it.
- **Duplicates.** A repeated `dst` is routed once and listed once.
- **Logs.** One JSON line per request (`requestId`, `path`, `status`, `durationMs`, `destinationCount`, `upstreamLatencyMs`, `outcome`), plus one line per upstream failure with its detail. Coordinates can be customer addresses, so the query string and coordinates are never logged.

---

## Project structure

One Express 5 app. Routes validate input and shape the response. Anything that talks to the outside world lives in `src/services`, and small pure helpers live in `src/utils`.

`index.ts` only starts the process. `create-app.ts` exports `createApp(options)`, so tests boot the whole app on a random port with injected config and no process-level state.

```
src/
├── index.ts               process entry: reads env, starts the server (also Vercel's entry)
├── create-app.ts          composition root: config, request context, routes, error handler
├── routes/routes.ts       GET /routes: validation, fan-out, sorting, RoutingError → status
├── services/osrm.ts       OSRM client: error types, retries, 4 s per attempt
├── utils/
│   ├── coordinates.ts     "lng,lat" parsing and range checks
│   ├── concurrency.ts     bounded parallel map (5 in flight)
│   └── logger.ts          one JSON object per line
└── docs/
    ├── openapi.yaml       OpenAPI 3.1 spec, the source of the API docs
    └── docs.ts            Swagger UI at /docs, the spec at /openapi.json

test/
├── *.test.ts              groups A–F, the README check, the live OSRM test (see Testing)
├── fixtures/              real OSRM payloads
└── helpers/               app and OSRM-stub boot

scripts/vercel-check.sh    Vercel's build, run and checked locally (pnpm vercel:check)
docs/RELEASE_MANAGER.md    branch flow and release checklist

.github/
├── workflows/ci.yml           every check, on every PR
├── workflows/integration.yml  the live OSRM test, daily and on demand
├── actions/setup/             shared step: pnpm, Node from .nvmrc, cached install
└── dependabot.yml             weekly grouped updates for npm and actions

.husky/                    git hooks: commit-msg, pre-commit, pre-push
.npmrc                     hoists undici-types for Vercel's type check
tsconfig.json              type-check settings for src/ and test/ (no output)
tsconfig.build.json        build settings: src/ → dist/ (git-ignored)
```

---

## Development

### Stack

|              |                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**  | [Node.js 22](https://nodejs.org/docs/latest-v22.x/api/), [Express 5](https://expressjs.com/), ES modules                                                                                                                                                              |
| **Language** | [TypeScript](https://www.typescriptlang.org/), strict                                                                                                                                                                                                                 |
| **Routing**  | [OSRM](https://project-osrm.org/docs/v5.24.0/api/)                                                                                                                                                                                                                    |
| **API docs** | [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0), [Swagger UI](https://swagger.io/tools/swagger-ui/), [Redocly CLI](https://redocly.com/docs/cli/)                                                                                                                 |
| **Quality**  | [ESLint](https://eslint.org/) + [typescript-eslint](https://typescript-eslint.io/), [Prettier](https://prettier.io/), [Commitlint](https://commitlint.js.org/), [Husky](https://typicode.github.io/husky/), [lint-staged](https://github.com/lint-staged/lint-staged) |
| **Tests**    | [`node:test`](https://nodejs.org/docs/latest-v22.x/api/test.html), [Ajv](https://ajv.js.org/)                                                                                                                                                                         |
| **Tooling**  | [pnpm](https://pnpm.io/), [Portless](https://github.com/vercel-labs/portless), [GitHub Actions](https://docs.github.com/actions), [Vercel](https://vercel.com/docs/frameworks/backend/express)                                                                        |

Dev mode uses Node's built-in `--watch`, so there is no nodemon.

### How TypeScript runs

One set of `.ts` files, run two ways:

|                | Development and tests                                | Production                              |
| -------------- | ---------------------------------------------------- | --------------------------------------- |
| **Runs**       | the `.ts` files directly                             | plain JavaScript in `dist/`             |
| **How**        | Node's type stripping (`--experimental-strip-types`) | `pnpm build` (`tsc`), then `pnpm start` |
| **Extra deps** | none: no `tsx`, no `ts-node`                         | none                                    |

- **Same code both ways.** `tsconfig.json` sets `erasableSyntaxOnly`, so the code uses only syntax Node can strip: no `enum`, no namespaces with runtime code, no parameter properties. Imports use `.ts` paths, which `tsc` rewrites to `.js` (`rewriteRelativeImportExtensions`).
- **Type-checking is a separate step.** Type stripping removes types without checking them. `pnpm typecheck` checks them, and the pre-push hook and CI run it.
- **The warning.** On Node 22.15 type stripping is behind a flag and prints an experimental warning. The scripts silence it with `--disable-warning=ExperimentalWarning`. Production never uses the flag.
- **TypeScript is pinned to `~6.0`.** typescript-eslint, which runs the type-aware lint rules, does not support TypeScript 6.1+ or the native TypeScript 7 yet. Dependabot is told to hold it there.

### Environment

Copy `.env.example` to `.env`. Both `start` and `start:dev` load it if it exists (`--env-file-if-exists`). Never commit `.env`.

| Variable   | Default                          | Notes                                                                                    |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`     | `3000`                           | Ignored under `start:dev`: Portless sets it, and a variable already set wins over `.env` |
| `OSRM_URL` | `http://router.project-osrm.org` | No trailing slash. Use your own instance in production                                   |

### Git hooks

Husky runs these on every commit and push:

| Hook         | Runs                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-msg` | Commitlint: the message must follow [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(routes): sort by distance on equal duration` |
| `pre-commit` | lint-staged: Prettier and `eslint --fix` on staged files. An ESLint error that remains blocks the commit                                                  |
| `pre-push`   | `pnpm standard` and `pnpm typecheck` over the whole repo. Skip with `git push --no-verify` if you already checked                                         |

### Scripts

Run with `pnpm <name>`. `pnpm run` lists them all, and a test checks that this table matches `package.json`.

| Name                                      | What it does                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `start:dev`                               | Dev server via Portless at `https://ingrid.local`; restarts on any change under `src/`               |
| `build`                                   | Compile `src/` to `dist/` with `tsc` and copy `openapi.yaml` next to the compiled docs module        |
| `start`                                   | Production start: `node dist/index.js` (run `build` first), loads `.env`, at `http://localhost:3000` |
| `typecheck`                               | `tsc --noEmit` over `src/` and `test/`                                                               |
| `test`                                    | Every test, offline, against a local OSRM stub; the live OSRM test is skipped                        |
| `test:ci`                                 | Same tests, with readable output plus JUnit results in `junit.xml` (used by CI)                      |
| `test:integration`                        | The one test that calls the real OSRM (`OSRM_URL`, or the public demo server)                        |
| `standard` / `standard:fix`               | Prettier + ESLint: check, or fix                                                                     |
| `standard:format` / `standard:format:fix` | Prettier only: check, or fix                                                                         |
| `standard:lint` / `standard:lint:fix`     | ESLint only, with type-aware rules: check, or fix                                                    |
| `docs:lint`                               | Lint `src/docs/openapi.yaml` with Redocly (rules in `redocly.yaml`)                                  |
| `vercel:check`                            | Run Vercel's own build locally (no account needed), then start the bundle and call it                |
| `cache:clean`                             | Remove `node_modules`; run `pnpm install` afterwards                                                 |
| `commitlint`                              | Lint a commit message (the `commit-msg` hook runs it)                                                |
| `prepare`                                 | Install the Husky git hooks (runs on `pnpm install`)                                                 |

---

## Testing

```sh
pnpm test               # offline, no secrets, ~1–2 s
pnpm test:integration   # one request against the real OSRM
```

Tests use `node:test`. The only test dependency is `ajv`, which group F uses to check responses against the OpenAPI spec.

Every test except the live one runs against a local HTTP server that stands in for OSRM. The public demo server is rate-limited and shared, so a suite that called it would fail at random. The stub replies with real OSRM payloads (`test/fixtures/`) and counts calls and in-flight requests, so tests can check retries and concurrency.

| File                  | Group                    | Proves                                                                                   |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `contract.test.ts`    | A. Contract & happy path | exact body shape, duration-then-distance sort, client coordinates echoed back            |
| `validation.test.ts`  | B. Input validation      | each bad input → 400 **and** zero OSRM calls; the 100-destination cap                    |
| `upstream.test.ts`    | C. Upstream behaviour    | every OSRM failure → the right status; nothing about OSRM leaks to the client            |
| `resilience.test.ts`  | D. Resilience            | retry counts, bounded attempts, concurrency cap, per-request deadline                    |
| `operational.test.ts` | E. Operational           | `/health` works offline, one log line per request, no coordinates in logs, client cancel |
| `docs.test.ts`        | F. API docs              | every real response matches the spec; `/swagger-ui/` serves only its 4 files             |
| `readme.test.ts`      | README                   | the [Scripts](#scripts) table lists every `package.json` script, and no others           |
| `integration.test.ts` | Live contract (skipped)  | the brief's request works against the real OSRM                                          |

### CI

The git hooks can be skipped with `--no-verify`; CI cannot. [`ci.yml`](.github/workflows/ci.yml) runs on every pull request, every push to `main`, and on demand. Each check is its own job, and the jobs run in parallel, so a PR shows exactly which one broke:

| Job               | Runs                                           | Notes                                                      |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `Prettier`        | `pnpm standard:format`                         |                                                            |
| `ESLint`          | `pnpm standard:lint`                           | errors are annotated inline on the PR diff                 |
| `Typecheck`       | `pnpm typecheck`                               |                                                            |
| `Build`           | `pnpm build`, then start `dist/` and call it   | catches a file missing from `dist/`, which types cannot    |
| `Vercel build`    | `pnpm vercel:check`                            | Vercel's own build, bundle checks, then calls the function |
| `OpenAPI spec`    | `pnpm docs:lint`                               |                                                            |
| `Tests`           | `pnpm test:ci`                                 | JUnit report kept 14 days as the `junit-report` artifact   |
| `Commit messages` | Commitlint over the PR's commits               | PRs only; skipped for Dependabot                           |
| `CI passed`       | fails if any job above failed or was cancelled | **the one check to require in branch rules**               |

- **Same commands locally.** Every job is one `pnpm` script, so you can reproduce any failure with the same command.
- **Same setup.** CI uses the Node version from `.nvmrc` and installs with `--frozen-lockfile`.
- **Superseded runs.** A new push to a PR cancels that PR's run in progress. Runs on `main` always finish.
- **Pinned actions.** Actions are pinned to commit SHAs. Dependabot updates them and the npm packages weekly, in grouped PRs, and only to releases at least 7 days old.
- **Live OSRM test.** CI never calls the real OSRM, so a PR cannot fail because the shared demo server is slow. [`integration.yml`](.github/workflows/integration.yml) runs `pnpm test:integration` daily, and on demand with an optional `OSRM_URL`, to catch OSRM changing its contract. GitHub emails the workflow owner when a scheduled run fails.

**One-time setup on GitHub:** in _Settings → Rules → Rulesets_, require the `CI passed` status check on the protected branches; in _Settings → Code security_, enable Dependabot version updates.

---

## Deployment (Vercel)

The service deploys to Vercel with its zero-config **Express** preset, through the Git integration: every push gets a preview deployment, and `main` deploys to production. Vercel runs `pnpm build`, then type-checks and bundles `src/index.ts` itself into one function, which serves every endpoint, `/docs` included.

Vercel's build differs from ours, so a few things exist only for it:

| Concern           | What Vercel does                                                                                                       | What we do about it                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entry file**    | Takes the first of `app.*`, `index.*`, `server.*`, `src/app.*`, `src/index.*`, `src/server.*` that imports `'express'` | The app factory is `src/create-app.ts`, not `src/app.ts`, so Vercel picks `src/index.ts`. That file keeps an `import type { Express } from 'express'` so it qualifies, and calls `listen()` |
| **Type check**    | Uses its own TypeScript setup, which does not follow pnpm's symlinks                                                   | `.npmrc` hoists `undici-types`. Without it the global `Response` type is empty and the build fails, even though `pnpm typecheck` passes                                                     |
| **Bundled files** | Keeps only the files it can trace                                                                                      | `src/docs/docs.ts` reads `openapi.yaml` and `package.json` with a literal `new URL('./…', import.meta.url)`, which the tracer follows. A path in a variable drops the file                  |
| **Static files**  | Ignores `express.static()`, and reads `public/` before `pnpm build` runs                                               | The app serves the four files `/docs` loads by name, each found with a literal `require.resolve('swagger-ui-dist/…')`. Nothing else in the package is served                                |
| **Node version**  | Can select only a major version                                                                                        | `engines.node` is `>=22.15.1 <23`; `.nvmrc` pins the exact version locally                                                                                                                  |

`pnpm vercel:check` runs Vercel's own build locally (pinned CLI version, no account or token) and fails if:

- the entry is not `src/index.js`;
- `openapi.yaml` is missing from the bundle;
- the bundled function does not start and answer `/health`, `/openapi.json`, `/docs`, and every file `/docs` loads.

CI runs it as the `Vercel build` job, so a change that would break the deployment fails on the PR, not on Vercel.

---

## Contributing and releases

```
feat/*, fix/* ──PR──▶ scope/vX.Y.Z ──PR (freeze)──▶ release/vX.Y.Z ──PR──▶ main ──▶ tag vX.Y.Z
```

1. Branch from the open `scope/vX.Y.Z` as `feat/…`, `fix/…`, `docs/…`, and so on.
2. Open a PR into that scope branch. It needs a green `CI passed` and is **squash-merged**.
3. The release manager freezes the scope into `release/vX.Y.Z`, ships it to `main` and tags it. Those merges use **merge commits**.

[`docs/RELEASE_MANAGER.md`](docs/RELEASE_MANAGER.md) has the full flow: why it looks like this, hotfixes, and the release checklist.

---

## Limitations and next steps

- **Authentication and rate limiting: none.** The service is public, with no API key and no request budget of its own, while one request can fan out to 100 upstream calls. The cap of 5 OSRM calls is per request, so it does nothing against 100 concurrent callers: one abusive client can use up the shared OSRM quota for everyone. In production: an API key or mTLS at the gateway, a per-client budget, and a global cap on in-flight OSRM calls.
- **Load: not measured.** Next steps would be that global cap on concurrent OSRM calls and a circuit breaker around the OSRM client that fails fast with 503 once the error rate crosses a threshold.
- **Caching: not implemented.** Pickup-point lookups repeat the same src+dst pairs heavily. A TTL cache keyed on the coordinate pair rounded to ~5 decimals (≈1 m) would remove most upstream calls.
- **Self-hosted OSRM.** The demo server is not for production. Running our own means building the graph from an OSM extract (hours and tens of GB of RAM for Europe), repeating that on every map refresh, and running at least 2 instances behind a load balancer.
- **Metrics.** Worth exporting: requests by `outcome`, an upstream latency histogram, upstream attempts and retries, unroutable count. The log lines carry these fields today; nothing collects them.
- **Post-deploy check.** CI proves the Vercel build works but does not deploy, and nothing checks the deployed URL afterwards. A smoke test against `/health` and one `/routes` request would close that gap.
- **`/ready`: not implemented.** `/health` is liveness only and never calls OSRM. A readiness check that does would need its own short timeout and caching, so probes do not use up the rate limit.
- **Public docs.** `/docs` is served by the app, so `swagger-ui-dist` is a production dependency and ships publicly. In production the docs would sit behind a flag or on a separate host, with the spec published from CI.

---

## License

Private and unlicensed. All rights reserved.
