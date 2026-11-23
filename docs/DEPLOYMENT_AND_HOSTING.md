# VideoRisk v1.0 — Production & Staging Deployment Guide

> **Deployment Boundary Notice:** This guide documents how to build, configure, and run VideoRisk on a single Node 22 host or container. Executing builds and local startup verification locally does NOT imply deployment to an external cloud hosting platform unless explicitly provisioned and verified there.

---

## 1. Runtime & System Requirements

- **Node.js**: `>= 22.0.0` (required for built-in `node:sqlite` `DatabaseSync` and ESM server execution).
- **Media & OCR Binaries** (required for video processing and policy frame inspection):
  - `ffmpeg` and `ffprobe`
  - `tesseract` with `eng` and `tha` language data
  - Optional: local `whisper` binary and GGML model (`WHISPER_PATH`, `WHISPER_MODEL_PATH`, plus human speech verification fixture/manifest; see `docs/WHISPER_REAL_VERIFICATION_RUNBOOK.md`).

---

## 2. Production Build & Startup (No `tsx` Required in Runtime)

Build both the frontend Vite assets (`dist/`) and the Node 22 backend ESM bundle (`dist-server/server.mjs`):

```bash
npm ci
npm run build
```

For a runtime-only server image / host installation:

```bash
npm ci --omit=dev
npm start   # runs: node dist-server/server.mjs
```

Notes:
- `npm run dev` remains `tsx server.ts` for local development with Vite HMR/middleware.
- `dist-server/server.mjs` marks Node packages external (`--packages=external`) and NEVER imports `vite` or `tsx` when `NODE_ENV=production` or `DEPLOYMENT_ENV=staging`.
- Health probes:
  - Liveness: `GET /api/health/liveness`
  - Readiness: `GET /api/health/readiness`

---

## 3. Environment Tiers (`DEPLOYMENT_ENV`)

| Tier | `DEPLOYMENT_ENV` | `NODE_ENV` | Stripe Keys Allowed | Demo Seeding / Dev Reset Token / Simulation |
| :--- | :--- | :--- | :--- | :--- |
| Development | `development` | `development` | `sk_test_...` or unset | Allowed locally |
| Automated Test | `test` | `test` | `sk_test_...` or unset | Allowed in tests |
| Staging | `staging` | `production` | `sk_test_...` / `rk_test_...` only (`sk_live_` rejected) | Strictly disabled; HTTPS `APP_BASE_URL` required |
| Production | `production` | `production` | `sk_live_...` / `rk_live_...` only (`sk_test_` rejected) | Strictly disabled; HTTPS `APP_BASE_URL` & price IDs required |

Validate configuration before starting:

```bash
npm run validate:env -- --mode=staging     # staging check
npm run validate:env -- --mode=production  # live production check
```

Required core startup & billing variables in **Staging** & **Production**:
- `APP_BASE_URL` (valid non-localhost `https://...` origin)
- `MEDIA_TOKEN_SECRET` (cryptographic secret `>= 32` characters, non-placeholder)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`STRIPE_PRICE_*` required in Production; strongly recommended in Staging for `customer.subscription.*` webhooks)

Optional / feature-scoped configuration in **Staging** & **Production**:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` / `EMAIL_FROM` (**NOT required for server startup**, but **required before enabling real Password Reset email delivery** because `devResetToken` is suppressed in Staging & Production; live SMTP email delivery must be verified prior to enabling Password Reset or Production launch)
- `TRUST_PROXY` (`1` or explicit proxy/CIDR when deployed behind Nginx / ALB / Cloud Run)
- `WHISPER_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_REQUIRE_MODEL_SHA256`, `WHISPER_COMPAT_AUDIO_PATH`, `WHISPER_SPEECH_MANIFEST_PATH`, `WHISPER_STRICT_PROVENANCE`, `WHISPER_TRUSTED_PUBLIC_KEYS` (optional local Whisper STT; omitted leaves acoustic analysis active)

---

## 4. Storage, Persistence, Backups, and Single-Instance Constraints

VideoRisk uses local **SQLite with WAL mode** (`DATABASE_PATH`, default `data/videorisk.db`) and local filesystem storage for uploaded media, extracted proxies, and thumbnails (`uploads/`).

Operational constraints for real hosting:
1. **Persistent Volume Required**: Mount durable block/disk storage to both the SQLite directory (`data/` or `dirname(DATABASE_PATH)`) and `uploads/`. Ephemeral container disks lose user accounts, credits, billing state, and scan media across restarts/redeploys.
2. **WAL Sidecar Files**: Always keep `.db`, `.db-wal`, and `.db-shm` together on the same POSIX filesystem. Never copy `.db` raw while writes are occurring without a safe SQLite online backup (`sqlite3 data/videorisk.db ".backup '/backups/videorisk.db'"`), and checkpoint/quiesce during maintenance restores.
3. **Single-Instance Architecture**: Because SQLite locking and local `uploads/` files are host-local, deploy as a **single writer instance** (1 replica). Multi-replica horizontal scaling would require migrating storage/queue state to an external client-server database and shared object storage.
4. **Graceful Shutdown**: `server.ts` handles `SIGTERM` and `SIGINT` to close HTTP connections cleanly before exit. Configure orchestrator stop grace periods >= 10 seconds so in-flight requests drain cleanly.

---

## 5. Analysis Engine Boundaries, Backups & External Integration Checklists

- **Deterministic Local Analysis Pipeline (No External LLM API)**: VideoRisk's policy, channel, and context intelligence modules (`policyIntelligence.ts`, `channelIntelligence.ts`, `contextAnalyzer.ts`) and media processors (`mediaInspector.ts`, `audioProcessor.ts`, `videoProcessor.ts`, `thumbnailInspector.ts`) execute deterministically using Node.js and local binaries (`ffmpeg`, `ffprobe`, `tesseract`, optional local `whisper`). No external Gemini or LLM API key is required or called at runtime.
- **Database Backup & Restore Verification**:
  - Consistent online backups use `VACUUM INTO` (`SqliteStorageRepository.createBackup`) or `sqlite3 data/videorisk.db ".backup '/backups/videorisk.db'"`.
  - Restore verification must validate `PRAGMA integrity_check;` equals `'ok'` (`SqliteStorageRepository.restoreBackup`) and confirm row counts for `users`, `scans`, `reports`, `subscriptions`, `webhook_events`, and `credit_transactions`.
- **SMTP Email Delivery Verification**:
  - `POST /api/auth/forgot-password` dispatches reset emails via Nodemailer when `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are configured. Automated tests verify this path with a mocked Nodemailer transport; live SMTP delivery must be verified manually against your target mail provider in staging before go-live.
- **Stripe Billing Verification**:
  - Follow `docs/STRIPE_TEST_MODE_RUNBOOK.md` in an authorized `DEPLOYMENT_ENV=staging` environment to verify real Stripe Test Mode Checkout, HMAC webhook signatures, subscription lifecycle updates, cancellations, payment failures, and partial/full refunds end-to-end.

---

## 6. Staging vs. Production Environment Isolation & Pre-Launch Gates

Never share secrets, webhook endpoints, Stripe accounts/keys, domains, or SQLite/upload storage paths between **Staging** and **Production**:

| Control | Staging (`DEPLOYMENT_ENV=staging`) | Production (`DEPLOYMENT_ENV=production`) |
| :--- | :--- | :--- |
| Domain & HTTPS | Dedicated staging domain (`https://staging.<domain>`) | Dedicated production domain (`https://<domain>`) |
| Runtime & Payments | `NODE_ENV=production`, `PAYMENT_MODE=test` | `NODE_ENV=production`, `PAYMENT_MODE=live` |
| Stripe Keys | `sk_test_...` / `rk_test_...` + Staging `whsec_...` | `sk_live_...` / `rk_live_...` + Production `whsec_...` |
| Stripe Price IDs | Test-mode `price_...` IDs for all 4 paid plans | Live-mode `price_...` IDs (required; startup/validator fail closed if missing) |
| Simulation Fallback | Disabled (`ALLOW_SIMULATION_WEBHOOK=false`, 403/400 fail-closed) | Disabled (`ALLOW_SIMULATION_WEBHOOK=false`, 403/400 fail-closed) |
| `MEDIA_TOKEN_SECRET` | Dedicated Staging random secret (`>= 32` chars) | Distinct Production random secret (`>= 32` chars) |
| Storage & Backups | Isolated Staging `DATABASE_PATH` & `uploads/` volume | Dedicated persistent Production `DATABASE_PATH` & `uploads/` volume + scheduled backups |
| Logging & Redaction | `maskSecret()` / `sanitizeLogOutput()` redacts keys & tokens | Same redaction enforced; zero `.env` commits or secret echoes |

### Pre-Launch Gate Sequence
1. Validate configuration with `npm run validate:env -- --mode=staging` (in Staging) or `npm run validate:env -- --mode=production` (in Production; optional `--live-check` only with `ALLOW_LIVE_STRIPE_CHECK=true`).
2. Build and start the Node 22 ESM bundle (`npm run build && npm start`) and verify `GET /api/health/liveness` (`200`) and `GET /api/health/readiness` (`checks.database`, `checks.storage`, `checks.mediaSecurity`, `checks.billing`, `checks.whisperStt`).
3. Verify host Whisper provisioning (if enabled) with `npm run verify:whisper:prod -- --mode=production`.
4. Complete Category 2 Stripe Test Mode Checkout-to-Webhook verification in Staging per `docs/STRIPE_TEST_MODE_RUNBOOK.md` before activating any Live Stripe credentials in Production.

