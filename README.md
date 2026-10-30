# Harmattan

> The Harmattan is the West African trade wind that blows across borders from the Sahara to the Gulf of Guinea, and ignores every one of them. This project does the same for money.

Harmattan is the backend for a stablecoin cross-border payments sandbox, built for Cardtonic's *Operation Borderless* assessment. It is a REST API for multi-currency wallets holding **cNGN, cGHS, cXAF, USDx and EURx**, with simulated deposits, FX swaps, wallet-to-wallet transfers (same or different currency), transaction history, real-time balances and live conversion rates.

The focus is narrow: get the money right. Every amount is an integer, every money-moving request runs exactly once, parallel requests cannot overspend, and the API keeps working when the FX provider goes down.

---

## Contents

- [Quick start](#quick-start)
- [Tech stack and why](#tech-stack-and-why)
- [Why PostgreSQL](#why-postgresql)
- [Running the tests](#running-the-tests)
- [API walkthrough](#api-walkthrough)
- [Data model](#data-model)
- [Money precision](#money-precision)
- [Idempotency](#idempotency)
- [Concurrency](#concurrency)
- [FX rates and provider failures](#fx-rates-and-provider-failures)
- [Assumptions](#assumptions)
- [Known limitations and what I would do with more time](#known-limitations-and-what-i-would-do-with-more-time)

---

## Quick start

Requirements: Docker with Compose.

```bash
docker compose up --build
```

That starts PostgreSQL 16 and the API. The API container applies all database migrations (`prisma migrate deploy`) before it starts, so no extra step is needed. No seed data is needed either: create wallets through the API (see the walkthrough).

| What | Where |
| --- | --- |
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI spec (live) | http://localhost:3000/docs/openapi.json |
| OpenAPI spec (committed) | [`docs/openapi.json`](docs/openapi.json) |
| Health | http://localhost:3000/health |

If port 3000 is taken, run `API_PORT=8080 docker compose up --build`.

### Running without Docker

Requires Node.js 24 LTS (`.nvmrc`), Yarn 1 and a PostgreSQL database.

```bash
yarn install
cp .env.example .env          # then point DATABASE_URL at your Postgres
yarn prisma:migrate           # apply migrations
yarn start:dev
```

### Scripts

| Command | Purpose |
| --- | --- |
| `yarn test` | Full suite: unit and end-to-end tests |
| `yarn lint` | ESLint (type-aware) with Prettier |
| `yarn typecheck` | `tsc --noEmit` in strict mode |
| `yarn openapi` | Regenerate `docs/openapi.json` from the code |
| `yarn build` | Compile to `dist/` |

---

## Tech stack and why

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 24 LTS, TypeScript (`strict: true`) | Required. Strict mode, plus type-aware lint rules that ban `any` and floating promises. |
| Framework | NestJS 11 | Modules and dependency injection make it easy to swap the FX provider for a fake in tests, and DTO validation with Swagger generation comes built in. |
| Database | PostgreSQL 16 | See below. |
| ORM | Prisma 6 | Typed queries, readable schema, versioned SQL migrations. Raw SQL is used where precision matters (`SELECT ... FOR UPDATE`). |
| Validation | class-validator / class-transformer | Request DTOs are whitelisted, so unknown fields are rejected. |
| Docs | @nestjs/swagger | The spec is generated from the code, so it cannot drift. |
| Tests | Jest, Supertest, Testcontainers | End-to-end tests run against a real Postgres, because locking and constraints cannot be tested against mocks. |
| Tooling | Yarn, ESLint 9, Prettier | Required. |
| Cache / queue | None | Postgres row locks and a unique index handle concurrency and idempotency. Redis would add a second source of truth without adding correctness at this scale. The FX cache is in memory, backed by a Postgres snapshot. |

## Why PostgreSQL

This is a ledger, so I wanted the database itself to guarantee the rules, not just the application:

- **ACID transactions across rows.** A transfer debits one balance, credits another, writes a transaction and two ledger entries. All of that commits or none of it does.
- **Row-level locks** (`SELECT ... FOR UPDATE`) give simple, provable protection against double-spending.
- **Exact decimals.** `NUMERIC(38,0)` stores minor units with no float rounding and no practical overflow.
- **Constraints as a safety net.** `CHECK (amount >= 0)` on balances, unique email and phone, a unique idempotency key, CHECKs on transaction shape, and a trigger that makes the ledger append-only. Even an application bug cannot persist a negative balance.

MongoDB has multi-document transactions, but it lacks this combination of exact numerics, row locks and declarative constraints, so it would be the weaker choice for money. MySQL would also work; I chose Postgres for its richer CHECK constraints and triggers.

---

## Running the tests

```bash
yarn install
yarn test
```

The only requirement is a running Docker daemon. Jest's global setup uses **Testcontainers** to start a throwaway `postgres:16-alpine` container and applies the migrations. It tears the container down afterwards. To use an existing database instead, set `TEST_DATABASE_URL`.

The suite runs about 90 tests in about 10 seconds:

| Suite | What it proves |
| --- | --- |
| `src/common/money.spec.ts` | Parsing and formatting, `0.1 + 0.2 === 0.3`, rounding down, and that a round-trip conversion never creates value |
| `src/rates/rates.service.spec.ts` | Fallback order LIVE → CACHED → FALLBACK, recovery, TTL cache, single-flight refresh, failure backoff |
| `test/e2e/wallets.e2e-spec.ts` | Creation by email or phone, uniqueness (including concurrent duplicates), validation, USD total |
| `test/e2e/money-movements.e2e-spec.ts` | Deposits, swaps and transfers, rounding, insufficient funds, idempotent replay, key reuse |
| `test/e2e/concurrency.e2e-spec.ts` | **20 parallel transfers trying to overspend** (exactly 10 succeed), parallel swaps, **the same key sent 10× in parallel** (one transaction), opposite-direction transfers (no deadlock), DB constraint and append-only trigger |
| `test/e2e/history-and-rates.e2e-spec.ts` | Newest-first history, pagination, type and currency filters, fetch by id, all 20 rate pairs, **provider outage** (CACHED, then FALLBACK) with swaps and transfers still working and recording their rate source |

After every money test, a ledger invariant check confirms that **each balance equals the sum of its ledger entries**.

To check the concurrency tests have teeth, I removed `FOR UPDATE` from the balance lock as an experiment. Three of them failed: overspend, lost updates, and deadlock.

---

## API walkthrough

All amounts are **decimal strings** with up to 6 decimal places (`"1500.25"`), never JSON numbers. Every `POST` that moves money needs an **`Idempotency-Key`** header. Errors share one shape with a stable `code`:

```json
{ "statusCode": 422, "code": "INSUFFICIENT_FUNDS", "message": "Insufficient cGHS balance",
  "details": { "currency": "cGHS", "available": "10.000000", "requested": "10.000001" },
  "path": "/wallets/…/swaps", "timestamp": "2026-10-30T06:57:48.558Z" }
```

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/wallets` | Create a wallet (email or phone) |
| `GET` | `/wallets/:walletId` | Wallet, balances and USD total |
| `GET` | `/wallets/:walletId/balances` | Real-time balances and USD total |
| `POST` | `/wallets/:walletId/deposits` | Simulated deposit |
| `POST` | `/wallets/:walletId/swaps` | Swap between stablecoins in one wallet |
| `POST` | `/wallets/:walletId/transfers` | Send to another wallet, same or different currency |
| `GET` | `/wallets/:walletId/transactions` | History: newest first, `?type=&currency=&page=&pageSize=` |
| `GET` | `/transactions/:transactionId` | One transaction |
| `GET` | `/rates` | All 20 pair rates with last refresh time |
| `GET` | `/rates/quote?from=&to=&amount=` | Read-only quote for one pair |
| `GET` | `/health` | Liveness and DB check |

The responses below come from a real run against the live provider.

### 1. Create wallets

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

`201 Created`

```json
{
  "id": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "email": "ada@example.com",
  "phone": null,
  "createdAt": "2026-10-30T06:57:46.516Z",
  "walletId": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "balances": [
    { "currency": "cNGN", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cGHS", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cXAF", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "USDx", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "EURx", "amount": "0.000000", "usdValue": "0.000000" }
  ],
  "totalUsd": "0.000000",
  "valuation": { "rateSource": "LIVE", "ratesAsOf": "2026-10-30T06:57:48.387Z" }
}
```

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"phone":"+233 20 123 4567"}'          # stored as +233201234567
```

Creating a second wallet with the same email (case-insensitive) or phone returns `409 WALLET_ALREADY_EXISTS`. Sending neither returns `400 IDENTITY_REQUIRED`.

### 2. Deposit

```bash
curl -X POST localhost:3000/wallets/$ADA/deposits \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-deposit-0001' \
  -d '{"currency":"USDx","amount":"250"}'
```

`201 Created`, header `Idempotent-Replayed: false`

```json
{
  "id": "55c39cc3-5889-4ad8-952b-4b1157ed721a",
  "type": "DEPOSIT",
  "status": "COMPLETED",
  "sourceWalletId": null,
  "destinationWalletId": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "sourceCurrency": "USDx",
  "sourceAmount": "250.000000",
  "destinationCurrency": "USDx",
  "destinationAmount": "250.000000",
  "rate": "1",
  "rateSource": "IDENTITY",
  "rateAsOf": "2026-10-30T06:57:48.512Z",
  "createdAt": "2026-10-30T06:57:48.516Z"
}
```

Sending the same request again with the same key returns **`200 OK`** with the same body and `Idempotent-Replayed: true`, and the balance is not credited twice.

### 3. Swap

```bash
curl -X POST localhost:3000/wallets/$ADA/swaps \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-swap-0001' \
  -d '{"fromCurrency":"USDx","toCurrency":"cNGN","amount":"100"}'
```

`201 Created`

```json
{
  "id": "fa19ddc0-8a17-46d5-adf4-23b03b216c0a",
  "type": "SWAP",
  "status": "COMPLETED",
  "sourceWalletId": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "destinationWalletId": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "sourceCurrency": "USDx",
  "sourceAmount": "100.000000",
  "destinationCurrency": "cNGN",
  "destinationAmount": "134622.382300",
  "rate": "1346.223823",
  "rateSource": "LIVE",
  "rateAsOf": "2026-10-30T06:57:48.387Z",
  "createdAt": "2026-10-30T06:57:48.537Z"
}
```

Swapping more than the balance returns `422 INSUFFICIENT_FUNDS`, and nothing changes.

### 4. Transfer, converting across currencies

```bash
curl -X POST localhost:3000/wallets/$ADA/transfers \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-transfer-0001' \
  -d '{"toWalletId":"'$KOFI'","fromCurrency":"cNGN","toCurrency":"cGHS","amount":"50000"}'
```

`201 Created`. The record holds the sender, receiver, source amount and currency, destination amount and currency, applied rate and timestamp:

```json
{
  "id": "7546b0b0-f500-49e9-82f2-ef49a7bcd5f3",
  "type": "TRANSFER",
  "status": "COMPLETED",
  "sourceWalletId": "e1ea6f4e-c9eb-415a-8136-fd0afd576c9a",
  "destinationWalletId": "e94be9dc-918f-4f8a-87e5-5ef9ce8f823e",
  "sourceCurrency": "cNGN",
  "sourceAmount": "50000.000000",
  "destinationCurrency": "cGHS",
  "destinationAmount": "432.991446",
  "rate": "0.008659828923",
  "rateSource": "LIVE",
  "rateAsOf": "2026-10-30T06:57:48.387Z",
  "createdAt": "2026-10-30T06:57:48.558Z"
}
```

Leave out `toCurrency` for a same-currency transfer (`rate: "1"`, `rateSource: "IDENTITY"`). Sending to yourself returns `400 SELF_TRANSFER`; use a swap instead.

### 5. Balances with USD total

```bash
curl localhost:3000/wallets/$KOFI/balances
```

```json
{
  "walletId": "e94be9dc-918f-4f8a-87e5-5ef9ce8f823e",
  "balances": [
    { "currency": "cNGN", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cGHS", "amount": "432.991446", "usdValue": "37.140926" },
    { "currency": "cXAF", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "USDx", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "EURx", "amount": "0.000000", "usdValue": "0.000000" }
  ],
  "totalUsd": "37.140926",
  "valuation": { "rateSource": "LIVE", "ratesAsOf": "2026-10-30T06:57:48.387Z" }
}
```

### 6. History

```bash
curl 'localhost:3000/wallets/$ADA/transactions?pageSize=2'
curl 'localhost:3000/wallets/$ADA/transactions?type=TRANSFER&currency=cNGN&page=1'
```

```json
{
  "data": [
    { "id": "7546b0b0-…", "type": "TRANSFER", "direction": "OUT", "sourceCurrency": "cNGN", "destinationCurrency": "cGHS", "…": "…" },
    { "id": "fa19ddc0-…", "type": "SWAP", "direction": "SELF", "sourceCurrency": "USDx", "destinationCurrency": "cNGN", "…": "…" }
  ],
  "meta": { "page": 1, "pageSize": 2, "total": 3, "totalPages": 2 }
}
```

Results come newest first and include deposits, swaps, and transfers sent (`OUT`) and received (`IN`). `type` takes `DEPOSIT`, `SWAP` or `TRANSFER`. `currency` matches either side of a transaction. `pageSize` can be at most 100. `GET /transactions/:id` returns a single record.

### 7. Rates

```bash
curl localhost:3000/rates
```

```json
{
  "source": "LIVE",
  "currencies": ["cNGN", "cGHS", "cXAF", "USDx", "EURx"],
  "rates": [
    { "from": "cNGN", "to": "cGHS", "rate": "0.008659828923", "lastRefreshedAt": "2026-10-30T06:57:48.387Z" },
    { "from": "USDx", "to": "cXAF", "rate": "587.687873", "lastRefreshedAt": "2026-10-30T06:57:48.387Z" }
  ]
}
```

That is an excerpt; the full response lists all 20 ordered pairs. `GET /rates/quote?from=USDx&to=cXAF&amount=10` previews a conversion without moving money.

---

## Data model

```
wallets ─┬─< balances            (wallet_id, currency) PK, amount NUMERIC(38,0) CHECK >= 0
         ├─< transactions        source_wallet_id / destination_wallet_id, amounts, rate,
         │        │              rate_source, rate_as_of, idempotency_key UNIQUE, request_hash
         └─< ledger_entries >────┘  signed amount, balance_after; append-only (trigger)

fx_rate_snapshots                 currency PK, rate_per_usd NUMERIC(30,12), fetched_at
```

- **wallets**: `email` and `phone` are each unique and nullable, and a CHECK requires at least one.
- **balances**: one row per wallet per currency, all **created with the wallet**, so money movements only `UPDATE` existing rows and never race on an `INSERT`. `CHECK (amount >= 0)`.
- **transactions**: one row per deposit, swap or transfer, holding everything the brief asks to record: sender (`source_wallet_id`, null for deposits), receiver, source and destination amount and currency, the applied `rate`, its `rate_source` and `rate_as_of`, and `created_at`. CHECK constraints enforce the shape of each type (for example, a swap stays in one wallet and changes currency; a transfer goes between two different wallets).
- **ledger_entries**: one signed entry per balance change, plus `balance_after`. A database trigger makes the table append-only. For every wallet and currency, `SUM(ledger_entries.amount) = balances.amount`, and the tests check this after every money operation. The balance row is a fast, lockable cache of the ledger.
- **fx_rate_snapshots**: the last good live rate per currency, used when the provider is down.

The full schema is in [`prisma/schema.prisma`](prisma/schema.prisma), and the constraints are in [the migration](prisma/migrations).

---

## Money precision

- **Integers only.** Amounts are stored and computed as `bigint` **minor units with 6 decimal places** (`1 cNGN = 1,000,000`), in `NUMERIC(38,0)` columns. No float ever touches a balance.
- **Strings at the edge.** The API takes and returns amounts as decimal strings (`"1500.25"`). JSON numbers are rejected, because `0.1 + 0.2` should not be a problem the client can create. Input must match `^\d+(\.\d{1,6})?$`, be greater than zero and be at most 1,000,000,000 per operation. Output always has 6 decimals (`"1500.250000"`).
- **Rates** are `bigint` scaled by 10¹² and stored as `NUMERIC(30,12)`. Cross rates are computed through USD: `rate(A→B) = perUsd(B) / perUsd(A)`.
- **Always round down.** `destination = floor(source × rate)`. Rounding down means the system can never create money; any fraction below one minor unit stays with the platform. A conversion that would produce zero is rejected with `422 AMOUNT_TOO_SMALL`. The recorded `rate` is exactly the one applied, so anyone can recompute `destinationAmount` from the stored row.
- A unit test proves that converting A→B→A never returns more than you started with.

## Idempotency

Every deposit, swap and transfer needs an `Idempotency-Key` header (8–128 characters, such as a UUID). The key is stored on the transaction row under a **unique index**, alongside a SHA-256 **fingerprint** of the normalised request (operation, wallet, currencies, amount).

1. **Seen before.** If a committed transaction already has this key, the API returns it with `200 OK` and `Idempotent-Replayed: true`. If the fingerprint differs (same key, different request), it returns `422 IDEMPOTENCY_KEY_REUSED` instead of silently replaying the wrong thing. `"10"` and `"10.00"` count as the same request.
2. **Two at once.** The transaction row is the **first** write inside the database transaction. A concurrent request with the same key blocks on the unique index until the first one commits, then fails with a unique violation. The API catches that and replays the winner. Tested with 10 parallel identical requests: exactly one `201`, nine `200`s, and money moves once.
3. **Failures release the key.** If the operation fails (for example, insufficient funds), everything rolls back, the key included. A client can fix the cause and retry with the same key. This is tested.

Wallet creation needs no key because it is naturally idempotent: the unique email or phone makes a retry return `409`.

## Concurrency

Inside each money transaction:

1. Insert the transaction row (this serialises duplicate keys, as described above).
2. **Lock** every affected balance row with `SELECT … FOR UPDATE`, in a **fixed order** (wallet id, then currency). Concurrent operations on the same balance queue up instead of racing. The fixed order means A→B and B→A transfers running at the same time **cannot deadlock**.
3. Check funds **under the lock**, then update balances and append ledger entries.
4. As a final net, the `CHECK (amount >= 0)` constraint makes Postgres reject a negative balance even if the application were wrong.

The isolation level is Postgres's default, READ COMMITTED. The explicit row locks provide the serialisation that matters, without the retry storms SERIALIZABLE would cause under contention.

**Proof:** 20 parallel transfers of 10 USDx from a 100 USDx wallet produce exactly 10 × `201` and 10 × `422 INSUFFICIENT_FUNDS`, leaving the sender at `0.000000` and the receiver at `100.000000`, with a consistent ledger.

## FX rates and provider failures

Rates come from **[open.er-api.com](https://open.er-api.com)** (free, no API key, USD base). Each stablecoin maps to its fiat currency (cNGN→NGN, cGHS→GHS, cXAF→XAF, USDx→USD, EURx→EUR).

Each step falls back to the next:

| Order | Source | When |
| --- | --- | --- |
| 1 | `LIVE` | Provider answered (3 s timeout). Cached in memory for `FX_CACHE_TTL_SECONDS` (default 300 s). Each success is also saved to `fx_rate_snapshots`. |
| 2 | `CACHED` | Provider failed (timeout, non-200, malformed payload or missing currency). Serve the last saved snapshot, with its original `lastRefreshedAt`. |
| 3 | `FALLBACK` | Provider failed and no snapshot exists yet. Serve a static table compiled into the service (`src/rates/fallback-rates.ts`). |
| — | `IDENTITY` | Same-currency movement; rate is exactly 1 and no provider is needed. |

- **Rate source is recorded.** Every transaction stores `rate_source` and `rate_as_of`, so you can always tell which rate was used and how fresh it was. `/rates` and the balance valuation report the source too.
- **The provider is called carefully.** Concurrent refreshes share one in-flight request (single flight). After a failure, the provider is not called again for `FX_FAILURE_BACKOFF_SECONDS` (default 30 s), so an outage doesn't add a timeout to every request.
- **Payloads are validated.** Rates must be finite and positive, the base must be USD, and all five currencies must be present. Otherwise the payload is treated as a failure.
- The rate is quoted just before the database transaction and applied unchanged, and the record reflects exactly what was applied.

---

## Assumptions

- Each stablecoin is pegged **1:1** to its fiat currency, so its FX rate is the fiat rate.
- **No authentication**, as the brief allows. Anyone who knows a wallet id can act on it.
- A wallet is identified by an email, a phone number, or both. Emails are trimmed and lower-cased. Phones must be in E.164 format after spaces, dashes and brackets are removed (`+2348012345678`).
- Deposits are simulated, settle instantly and come from outside the system (`source_wallet_id = null`).
- No fees and no spread: swaps and transfers use the mid-market rate. The only value retained is sub-minor-unit rounding dust.
- 6 decimal places is enough precision for every supported currency. The maximum amount is 1,000,000,000 units per operation.
- Transactions are only ever `COMPLETED`, because everything settles synchronously.

## Known limitations and what I would do with more time

**Left out deliberately** (the brief says to scope it well):

- **Authentication and authorisation.** With more time: API keys or JWTs, wallet ownership checks, and OTP verification of the email or phone.
- **Rate locking.** The rate is read just before the database transaction. With more time: a `POST /quotes` endpoint returning a short-lived locked quote id that a swap or transfer can reference, so clients see the exact rate before committing.
- **Fees and spread**, plus limits (daily caps, KYC tiers).
- **True double entry.** The ledger records every balance change, and the balance-equals-ledger invariant holds. However, deposits and FX legs have no contra accounts. With more time: system accounts (an external deposits account, an FX conversion account per currency) so that every transaction's entries sum to zero per currency, plus a nightly reconciliation job.

**Known limitations:**

- Offset pagination can skip or repeat items if new transactions arrive between page requests. **Cursor pagination** (on `created_at, id`) would fix that.
- Idempotency keys never expire. A real system would expire them after about 24 hours, with a cleanup job.
- The in-memory rate cache is per process. With several API instances, each refreshes on its own (still correct, just more provider calls). With more time: share it through Redis, or refresh it in a single scheduled job.
- Rate-provider failures only appear in the logs. With more time: metrics and alerts on fallback usage, rate staleness and lock wait times, plus structured request logging with correlation ids.
- No rate limiting.
- Not done for lack of time: load testing beyond the concurrency tests, and CI (GitHub Actions running lint, typecheck and `yarn test`, which needs only Docker).
