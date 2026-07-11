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

## ⏳ Pending

| Phase | Item | Blocker / owner |
|---|---|---|
| 1 (dashboard) | **Re-add Warden's service** → real UUID | USER — old `svc-new-...` was a temp draft, never saved |
| 1 (dashboard) | **Register Provider B** (agent + service) | USER — key, wallet, serviceId |
| 1 (dashboard) | **Register Buyer** (agent, no service) | USER — key, wallet |
| 2 (funds) | Fund **Buyer** + **Warden** agent AA wallets with USDC | USER — exact amounts flagged before any transfer |
| 11 | Baseline test: Buyer → Provider A direct (no Warden) | needs agents + funding |
| 11 | **Good-path** E2E on mainnet | needs agents + funding |
| 11 | **Bad-path** E2E on mainnet | needs agents + funding |
| 12 | Demo video (≤5 min) | USER — screen-record terminal + dashboard |
| 14 | BUIDL submission on DoraHacks | USER — before deadline |

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
