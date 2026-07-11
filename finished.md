# Warden — Build Status

_Last updated: 2026-07-12_

## ✅ Done (code complete, typechecks clean)

| Phase | Item | Notes |
|---|---|---|
| 0 | Project scaffold, secrets lockdown, `.gitignore` | real key in gitignored `backend/.env`; `.env.example` is placeholders |
| 0 | CROO SDK verified against `@croo-network/sdk@0.2.1` | real API confirmed; corrections applied (snake_case events, `deliverableText`, ctor shape) |
| 0 | Connectivity smoke test | ✅ Warden connected, went ONLINE, WS + REST auth verified |
| 1 | Shared layer | env loader, tagged logger, client factory (1 WS/key), p-queue nonce guard, Groq wrapper |
| 2 | Demo Provider A (good) + B (forced-bad toggle) | Groq-backed; B off-topic delivery is an honest test fixture |
| 3 | Warden core orchestrator | both roles on one WS, event routing by job id, job store |
| 4 | **Pluggable policy engine** | `policies.ts`: min/max_length, no_placeholder, contains/not_contains, regex, json_valid, json_fields, semantic — buyer attaches a bundle per order; domain-agnostic |
| 4 | Offline policy test | ✅ `npx tsx src/scripts/testPolicies.ts` — good passes, off-topic fails on `contains`, empty fails on `no_placeholder`, JSON passes |
| 5 | Settlement | pass→`deliverOrder`, fail→`rejectOrder`, on-chain audit log naming the deciding policy |
| 6 | Demo buyer | good/bad mode (`npm run buyer` / `-- bad`) |
| 8 | README + LICENSE (MIT) + this file | real-vs-roadmap, SDK methods, setup all documented |

## ✅ LIVE E2E ON BASE MAINNET — BOTH PATHS PROVEN (real USDC)

**GOOD path** — Order A `4a0c11d9` → status `completed`:
- Buyer pays Order A: `0x4423adc840baefbd078e39d54b2beb94032b80a3e8d92c8f745ede9a1a565ba0`
- Warden pays Order B `1453685b`: `0xced514c515855446e18bbb2745c41e4fdfeabbac8f562d1077829d39f06aa886`
- Provider A delivers real summary → Warden runs 4 policies → **PASS**
- Warden delivers Order A: `0x922b2c1ec73855133889ab9a6c0e410ba3b052d442a0f4d642b5b0dcd2f77515`
- Escrow CLEAR to Warden: `0x387a8c35639ee85441595e990698f914116c7efc10ecafacb1cc5943de9fd839`

**BAD path** — Order A `9f1c2e15` → status `rejected`:
- Buyer pays Order A: `0x32014ae6221c7402fb4842564937fae7a2e4606d1dc46486801906c7632fde54`
- Provider B (forced-bad) delivers off-topic text: `0x8a6f993a9d0bc7b240982bd62c5398df62e966149be9a0f803aeada7c14c14b7`
- Warden gate **FAIL** on `policy: contains` ("Delivery must contain \"Webb\" but does not")
- Warden rejects Order A → buyer refunded: `0x12c81ef1dac2146a70151d0fc99e5ed49d6be917eefdf2a4423c828e8ea8a389`

## ✅ v2 — `code_tests` policy: verifiable execution in a hardened Docker sandbox

The flagship upgrade. Warden runs untrusted provider code against the buyer's test
suite inside a locked-down container (`--network=none --read-only --user nobody
--cap-drop ALL --memory=128m --pids-limit --no-new-privileges` + host-side timeout).
Escrow releases only on a green suite. `src/warden/sandbox.ts` + `code_tests` policy.

- Offline proof (`npx tsx src/scripts/testSandbox.ts`): good code passes, buggy code fails the exact test, **malicious network code is blocked** (`Network is unreachable`).
- **GOOD code path (on-chain)** — Order A `f1d73efd` → `completed`. Provider A wrote real `is_palindrome` → sandbox ran buyer's 5 tests → all pass → delivered. Deliver tx `0xce958e45428aab1bb70ba4410028df147fd8184e15da8720c275a07c64fb15e4`.
- **BAD code path (on-chain)** — Order A `c7fa2b0b` → `rejected`. Provider B delivered non-code → sandbox load `SyntaxError` → `policy: code_tests` failed → buyer refunded. Reject tx `0xf1234b2199e5831c8e2b5a8b96e73b98c6585829a8358400e67808973fc17f4f`.

**Key integration findings (from live testing):**
- CAP's Paymaster is a **USDC paymaster** — every agent wallet (incl. providers) needs a small USDC balance for gas, or accept/deliver fails with `PIMLICO_ERROR: sender has no balance of the token`.
- `requirements` on `negotiateOrder` **must be valid JSON** (Warden now wraps the task as `{input}`).
- Requester pays only `price`; the platform fee is handled separately (not added on top).
- Total real spend across all test runs (gas + fees): **~0.12 USDC**. Rest recoverable via Withdraw.

## ⏳ Pending (USER)

| Phase | Item | Owner |
|---|---|---|
| 12 | Demo video (≤5 min): gap → mechanism → good run → bad run → honest close | USER |
| 14 | BUIDL submission on DoraHacks before deadline | USER |
| — | (optional) Withdraw remaining USDC from agent wallets back to main wallet | USER |

## `.env` fill status

- [x] `CROO_API_KEY` (Warden)
- [x] `WARDEN_AA_WALLET` (agent wallet `0xcA01…5D72`)
- [ ] `WARDEN_SERVICE_ID` — needs real UUID after re-adding service
- [x] `GROQ_API_KEY`
- [x] `PROVIDER_A_API_KEY` / `PROVIDER_A_AA_WALLET` / `PROVIDER_A_SERVICE_ID`
- [ ] `PROVIDER_B_API_KEY` / `PROVIDER_B_AA_WALLET` / `PROVIDER_B_SERVICE_ID`
- [ ] `BUYER_API_KEY` / `BUYER_AA_WALLET`

## Money safety

- Total budget: **15 USDC** on Base mainnet, currently in test wallet.
- No funds moved yet. Exact amounts will be flagged before any transfer.
- Planned demo prices: Warden service **0.10**, provider service **0.05** — tiny by design.
