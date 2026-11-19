# Hotel Offer Orchestrator

Aggregates overlapping hotel offers from two **mocked** supplier APIs, de-duplicates by hotel name, picks the cheapest offer per hotel, caches the result in **Redis** and supports **price-range filtering inside Redis**. The aggregation is orchestrated by **Temporal**.

**Stack:** Node.js 22 · TypeScript · Express · Temporal · Redis · Docker Compose

## Architecture

```
Client ──GET /api/hotels──▶ Express API ──start workflow──▶ Temporal ──▶ Worker
                                │                                         │
                                │                          ┌──────────────┼───────────────┐
                                │                          ▼ (parallel)   ▼               │
                                │                  fetchSupplier A  fetchSupplier B       │
                                │                          └──────┬───────┘               │
                                │                           dedupe (cheapest wins)         │
                                │                                 ▼                        │
                                │                         saveOffersToRedis                │
                                │                                 ▼                        │
                                ◀──────── result ──────  filterOffersInRedis (if min/max)  │
```

| Piece | File |
|---|---|
| Workflow (orchestration) | `src/temporal/workflows.ts` |
| Activities (supplier calls, Redis) | `src/temporal/activities.ts` |
| Worker | `src/temporal/worker.ts` |
| Dedupe logic (pure function) | `src/shared/dedupe.ts` |
| Redis storage + price filter | `src/redis.ts` |
| REST API + `/health` | `src/api/app.ts` |
| Mock suppliers | `src/mock/suppliers.ts` |

### Workflow behaviour
1. Calls **Supplier A and B in parallel** (each activity: 3s HTTP timeout, up to 3 attempts with backoff).
2. De-duplicates by hotel name (case-insensitive); the **cheaper price wins**; a hotel in only one list is kept.
   *Price tie:* higher commission wins, then Supplier A (deterministic).
3. Saves the de-duplicated list to Redis (atomic replace, 1h TTL).
4. If `minPrice`/`maxPrice` is given, the filter is executed **by Redis**.
5. If one supplier is down after retries, the workflow continues with the other one (response header `X-Degraded-Suppliers`, and Redis is *not* overwritten with partial data). If both are down → `502`.

### Redis model (per city)
| Key | Type | Content |
|---|---|---|
| `hotels:<city>:prices` | ZSET | member = hotel name, score = price |
| `hotels:<city>:data` | HASH | hotel name → JSON offer |

Filtering = `ZRANGEBYSCORE hotels:<city>:prices <min|-inf> <max|+inf>` (inclusive) then `HMGET` for the matching offers.

## Run with Docker (recommended)

Requires Docker + Docker Compose.

```bash
docker compose up --build -d
```

Starts `redis`, `temporal` (dev server; Web UI at http://localhost:8233), `api` (http://localhost:3000) and `worker`.

```bash
curl "http://localhost:3000/api/hotels?city=delhi"
curl "http://localhost:3000/api/hotels?city=delhi&minPrice=3000&maxPrice=6000"
curl  http://localhost:3000/health
docker compose logs -f api worker      # structured JSON logs
docker compose down                    # stop
```

## Run locally (without Docker for the app)

Needs Node ≥ 20, a Redis on `:6379` and a Temporal server on `:7233` (e.g. `temporal server start-dev`).

```bash
npm install
npm run build
npm run start:worker &     # terminal 1
npm run start:api          # terminal 2
```

Config via env vars: `PORT`, `REDIS_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `SUPPLIER_BASE_URL`, `SUPPLIER_TIMEOUT_MS`, `CACHE_TTL_SECONDS`, `WORKFLOW_TIMEOUT_MS`, `ENABLE_FAILURE_INJECTION` (see `src/config.ts`).

## API

### `GET /api/hotels?city=<city>[&minPrice=<n>][&maxPrice=<n>]`
Returns the de-duplicated best offers, sorted by price ascending. Bounds are inclusive and each is optional. Unknown city → `[]`.

```json
[
  { "name": "Holtin",  "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

| Status | When |
|---|---|
| 200 | success (possibly `[]`) |
| 400 | missing/invalid `city` (1-64 letters, digits, spaces, `.'-`), non-numeric/negative price, or `minPrice > maxPrice` |
| 503 | API is up but not yet connected to Temporal |
| 502 | both suppliers unavailable |

Test hook: `&simulateDown=A`, `B` or `A,B` makes the mock supplier(s) answer 503, to demo failure handling. It is **disabled by default** (`ENABLE_FAILURE_INJECTION=false`; the compose file enables it so the Postman collection works) and returns 400 when disabled.

### Mock suppliers
`GET /supplierA/hotels` and `GET /supplierB/hotels` (optional `?city=`). Static data for `delhi` and `mumbai` with intentionally overlapping hotel names.

### `GET /health`  *(bonus)*
Reports `supplierA`, `supplierB`, `redis` and `temporal` individually; `200` when everything is up, `503` otherwise.

```json
{ "status": "ok", "checks": { "supplierA": {"status":"up","ms":25}, "supplierB": {"status":"up","ms":12}, "redis": {"status":"up","ms":2}, "temporal": {"status":"up","ms":3} } }
```

## Postman collection
Import `postman/hotel-offer-orchestrator.postman_collection.json` (variable `baseUrl` defaults to `http://localhost:3000`). It covers: delhi with overlaps, price filters, city with no results, validation errors, **supplier A/B/both down**, mock suppliers and `/health`; every request has test assertions. Headless:

```bash
npx newman run postman/hotel-offer-orchestrator.postman_collection.json
```

## Tests
```bash
npm test
```
Unit tests cover the dedupe rules. The end-to-end suite starts a real Redis (`redis-server` must be on PATH) and a local Temporal test server, then drives the real Express app and worker. If the Temporal test-server download is blocked, point to an existing CLI: `TEMPORAL_CLI_PATH=/path/to/temporal npm test`.

## Design decisions and trade-offs
- **Dedupe is a pure function inside the workflow**, not an activity: it is deterministic, needs no I/O, and is trivially unit-tested. Everything with side effects (HTTP, Redis) is an activity.
- **`Promise.allSettled` for the supplier calls**, so one supplier failing never fails the other; only "both down" fails the request.
- **Retries only for transient errors**: timeouts, network errors, 5xx/408/429. Other 4xx and malformed payloads fail fast.
- **Degraded runs don't touch Redis.** Partial data never overwrites a complete cache entry. Trade-off: in a degraded run the price filter is applied in memory on that run's results rather than in Redis.
- **Every request runs a workflow** (as the brief asks). A cache-aside shortcut (serve fresh Redis data directly) would cut latency/load, at the cost of staleness; easy to add using the TTL already in place.
- **Redis ZSET + HASH** gives O(log N + M) range queries; the save is one `MULTI` transaction, so readers never see a half-written city.
- **Price tie-break** (same price from both suppliers): higher commission wins, then Supplier A, so results are deterministic.
- **API starts listening before Temporal is reachable**; `/health` and `503` say what is missing, and the API connects in the background.
- **Temporal dev server in compose** uses in-memory persistence: fine for a demo, use a real Temporal cluster/Postgres in production.

## Logging & error handling *(bonus)*
Structured JSON logs for HTTP requests and, via the Temporal logger, for every workflow/activity step (supplier calls, latency, failures, Redis writes). Supplier failures are retried by Temporal; a non-array supplier payload is a non-retryable error; failures map to clear HTTP statuses.
