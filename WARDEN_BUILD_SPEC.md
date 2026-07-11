# Warden — CAP Quality-Gated Escrow Proxy
### Full Build Spec — CROO Agent Hackathon (deadline 2026-07-12 14:30)

---

## 0. One-liner

> CAP standardizes negotiation, escrow, delivery, and settlement — but once a Provider calls `deliverOrder`, funds release automatically with zero Requester approval. Warden is a CAP-native agent that sits between buyer and provider as both Provider and Requester simultaneously, enforcing a real quality gate using nothing but composed Orders, escrow, and the existing reject/refund path. No invented protocol features. No dispute state that doesn't exist. Just correct use of what CAP already ships.

---

## 1. The Gap (cited precisely, not paraphrased loosely)

Two CROO documents disagree, and this matters:

- **Marketing/whitepaper language** ("CAP Core Mechanics") describes a `Dispute` entity — "Arbitration for failed Clear stage" — and "Verifier/Reviewer (Optional)."
- **The actual Smart Contracts doc** shows the real on-chain state machine:
  ```
  NEGOTIATION ──[payOrder]──► LOCK ──[deliverOrder]──► DELIVER ──[evaluateOrder]──► CLEAR
  ```
  This is a genuinely important finding: **`evaluateOrder` and a `needEvaluation` flag DO exist at the contract level.** `deliverOrder` with `needEvaluation=false` skips DELIVER and goes straight to CLEAR (this is the default path documented in the SDK and Order Lifecycle docs). `evaluateOrder` is **not exposed anywhere in the public Node.js SDK Reference** — it's not in the method table, not in Quick Start, not in Order Lifecycle. It appears to be reserved for internal/platform use only, not yet available to third-party builders.

**What this means, precisely:** CAP's own architecture already anticipates a verification gate before settlement — but hasn't shipped public access to it yet. Warden doesn't wait for CROO to expose `evaluateOrder`. It builds the equivalent guarantee **today**, in userland, by composing two ordinary Orders — proving out exactly the pattern CAP's own contract layer is heading toward, without needing any protocol change or invented state.

This is a stronger, more precise pitch than "CROO's dispute flow is fake" — it's "CROO's contract layer already points at this exact gap; we filled it using only public primitives."

---

## 2. The Mechanism

```
                    Order A (buyer-facing)              Order B (sub-order)
Buyer ────negotiate──────► Warden ────negotiate──────► Real Target Provider
Buyer ────payOrder────────► [escrow A]
                              Warden ──payOrder─────────► [escrow B]
                                                Real Provider ──deliverOrder──►
                              Warden ◄──order_completed (Requester-side push)
                              Warden: getDelivery(orderB) → run quality gate
                    ┌─────────────────────┴─────────────────────┐
                 PASS                                          FAIL
                    │                                            │
     Warden.deliverOrder(orderA, data) ──►        Warden.rejectOrder(orderA, reason) ──►
     escrow A releases to Warden                  escrow A auto-refunds to Buyer
     (minus Warden's margin, minus platform fee)   (CAP's own paid-status refund path)
```

Warden is **one Agent, one wallet, one API key, one WebSocket connection** — it plays Provider on Order A and Requester on Order B from the same process. Nothing here requires two identities.

---

## 3. Critical Risk Log — read this before writing code

Every one of these is a place you could get stuck. Mitigation included for each.

| # | Risk | Why it happens | Mitigation |
|---|------|-----------------|------------|
| 1 | **`evaluateOrder` isn't callable by us** | Not in SDK | Don't try to call it. Warden never touches DELIVER/evaluateOrder state — it always uses `needEvaluation=false` (the default), and enforces quality via the two-order composition instead. |
| 2 | **One WebSocket connection per API key** (code 1008 if violated) | FAQ, confirmed | Warden runs a single long-lived `AgentClient` + single `connectWebSocket()` call for its whole life. Never spin up a second connection with the same key, even in tests — kill the old process first. |
| 3 | **Concurrent `PayOrder` calls collide on wallet nonce** (`NONCE_ERROR`/`PIMLICO_ERROR`) | FAQ, confirmed | Warden must **queue** its own outgoing `payOrder` calls (it's a Requester on every Order B). Use a simple async mutex/queue (you've done this exact pattern before with p-queue in Wave Protocol's x402 settlement — reuse it). One in-flight job at a time for MVP; queue extra buyer orders. |
| 4 | **Base Mainnet only — no testnet** | Smart Contracts + FAQ confirm Chain ID 8453 only | This means **real USDC**, small amounts, for every wallet in the demo (Warden's own float, buyer demo wallet, provider demo wallet(s)). Budget for this on day 1, don't discover it hours before the deadline. Gas itself is sponsored (Paymaster) — you never need ETH, only USDC. |
| 5 | **Warden needs float capital** | Warden must `payOrder` on Order B *before* it has released Order A's escrow to itself (it only calls `deliverOrder` on A *after* validating B's result) | Fund Warden's AA wallet with enough USDC to cover at least 2–3 concurrent sub-order prices before launch. At hackathon pricing ($0.01–$1/call) this is trivial — just don't forget to fund it. |
| 6 | **Marketplace is empty right now** (`agent.croo.network` shows "No popular services yet") | Confirmed via direct fetch | You cannot depend on real external providers existing yet. Build 2–3 of your own minimal "target provider" demo agents (Phase 10) as a guaranteed fallback, disclosed honestly in the README as demo/seed agents — not hidden. |
| 7 | **Anti-sybil concentration risk** | If you (solo) control buyer + Warden + all target providers, that's the exact "self-trade pattern" flagged for review | Mitigate by: (a) being transparent in the README about which counterparties are your own seed agents vs external, (b) actively trying to get 1–2 real other hackathon builders' agents to be either a real buyer of Warden or a real target provider Warden composes with, even late — worth a Discord post on day 1, not day 2. |
| 8 | **Rejection after `paid` can only be called by the Provider** | Order Lifecycle + FAQ confirm | This is exactly the role Warden holds on Order A — correct, no workaround needed. Just make sure Warden's reject-on-fail code path calls `rejectOrder(orderA_id, reason)`, not `expireAndRefund` (don't rely on waiting out the SLA timer for the bad-path demo — reject immediately, it's faster and more decisive on camera). |
| 9 | **Service price/SLA are fixed at registration, no live negotiation/haggling** | Service Registration doc: "Order parameters... automatically derived from the Service definition" | Don't build any counter-offer logic — there isn't one. `negotiateOrder` → Provider accepts or rejects, that's the entire negotiation surface. Simplifies Warden a lot; don't over-engineer this part. |
| 10 | **Deliverable integrity is a hash, not a signature/ZK proof** | Order Lifecycle: "keccak256 hash... written on-chain" | Don't oversell this in the README as "cryptographically verifiable" beyond what it is. It's a tamper-evident hash commitment — accurate and sufficient, just don't imply zero-knowledge proofs anywhere. |

---

## 4. Agents You Need To Register (Dashboard: agent.croo.network)

| Agent | Role | Service registered | Notes |
|---|---|---|---|
| **Warden** | Provider (to buyers) + Requester (to target providers) | "Verified Delivery Gateway" — schema requirements (see §6) | The actual project. One wallet, one API key. |
| **Demo Target Provider A** | Provider only | Simple real service (e.g. "Text Summarizer" via Groq) | Seed agent so Warden has something real to hire. Disclose in README as your own demo provider. |
| **Demo Target Provider B** | Provider only | A second, different simple service | Gives you a "good path" and a way to force a "bad path" (see Phase 11) without faking data. |
| **Demo Buyer** | Requester only | — | Hires Warden. This is your Navigator/second agent with a funded wallet. |

If you can get even one real external hackathon agent to plug in anywhere in this chain before submission, do it — see Risk #7.

---

## 5. Phase-by-Phase Build Plan

### Phase 0 — Environment
- [ ] Node.js 18+ confirmed (`node -v`)
- [ ] `npm install @croo-network/sdk`
- [ ] Groq SDK/account ready (reuse your existing Groq key from Mechloy if still valid, else new key at console.groq.com — free tier)
- [ ] Repo scaffolded: `warden/` with subfolders `src/warden`, `src/demo-providers`, `src/demo-buyer`, `src/shared`

### Phase 1 — Register Agents (Dashboard, one-time, manual)
- [ ] Sign in at agent.croo.network with your EOA wallet
- [ ] Register **Warden**: name, avatar, 1–5 skill tags (e.g. `trust`, `escrow`, `verification`, `infra`)
- [ ] Save Warden's API key immediately (`croo_sk_...`, shown once)
- [ ] Configure Warden's Service (see §6 for exact schema) — deliverable type `text`, requirements type `schema`
- [ ] Repeat registration for Demo Target Provider A and B (separate agents, separate API keys)
- [ ] Register Demo Buyer agent (or use your Navigator wallet directly — Navigator has its own AA wallet per Account & Wallet Architecture doc)
- [ ] Note every Agent's **AA Wallet Address** (Dashboard → Configure page) — NOT the Executor/Controller address, that distinction matters for funding

### Phase 2 — Fund Wallets (real USDC, Base Mainnet)
- [ ] Send small USDC amounts (Base, contract `0x8335...bdA02913`) to:
  - Warden's AA wallet (float capital — cover ~3x your sub-order price)
  - Demo Buyer's AA wallet (enough for several test orders)
- [ ] Demo Providers don't need funding (they only receive, never pay)
- [ ] Confirm balances show correctly in Dashboard before writing any code

### Phase 3 — SDK Bootstrap & Connectivity Smoke Test
- [ ] Set env vars per agent (each process gets its own `CROO_SDK_KEY`):
  ```bash
  export CROO_API_URL="https://api.croo.network"
  export CROO_WS_URL="wss://api.croo.network/ws"
  export CROO_SDK_KEY="croo_sk_...warden..."
  ```
- [ ] Write a throwaway script: connect `AgentClient`, call `connectWebSocket()`, log any event with `stream.onAny()`. Confirm Agent status flips to `online` in Dashboard.
- [ ] Confirm only ONE such process is running per API key (Risk #2) before moving on

### Phase 4 — Demo Target Provider Agents (build these first — Warden needs something real to hire)
- [ ] Minimal provider script per demo agent:
  ```ts
  const client = new AgentClient(config, process.env.CROO_SDK_KEY!);
  const stream = await client.connectWebSocket();
  stream.on(EventType.NegotiationCreated, async (e) => {
    await client.acceptNegotiation(e.negotiation_id);
  });
  stream.on(EventType.OrderPaid, async (e) => {
    const result = await runGroqTask(e.order_id); // your real logic, keep it simple
    await client.deliverOrder(e.order_id, { type: 'text', content: result });
  });
  ```
- [ ] Test end-to-end manually: use Demo Buyer to hire Demo Provider A directly (no Warden yet), confirm full negotiate → pay → deliver → settle cycle completes and funds move on-chain. **Do this before building Warden** — you need a known-working baseline to debug against.

### Phase 5 — Warden Core: Provider-Side (accepting buyer orders)
- [ ] `stream.on(EventType.NegotiationCreated, ...)` → validate the buyer's schema payload (must include `targetServiceId` + `acceptanceCriteria`, see §6) → `acceptNegotiation`
- [ ] `stream.on(EventType.OrderPaid, ...)` → this is your trigger to move to Phase 6 (hire the real provider). Store `orderA_id` + buyer's acceptance criteria in an in-memory (or lightweight DB, e.g. SQLite) job record keyed by `orderA_id`.

### Phase 6 — Warden Core: Requester-Side (hiring the real provider)
- [ ] On job start: `client.negotiateOrder({ serviceId: job.targetServiceId, ... })`
- [ ] Wait for provider to accept (this happens off-chain/fast) → on-chain Order B created
- [ ] **Queue-guarded** `client.payOrder(orderB_id)` (Risk #3 — never call payOrder concurrently even across different jobs; use a single-worker queue)
- [ ] `stream.on(EventType.OrderCompleted, ...)` fires when the real provider delivers to Order B (this event is pushed to the Requester — Warden, in this case)
- [ ] `client.getDelivery(orderB_id)` → fetch the real deliverable

### Phase 7 — Quality Gate (Groq-backed validator)
- [ ] Two-layer check, in this order (fail fast on layer 1, it's free and instant):
  1. **Rules layer** (no LLM call): does the delivery match the schema type declared? Non-empty? Matches basic structural expectations from `acceptanceCriteria` (required fields present, no obvious garbage/error strings)?
  2. **Semantic layer** (Groq call, only if layer 1 passes and criteria include a semantic check): does the content actually address the buyer's stated ask? Simple yes/no + confidence, one Groq call, `llama-3.3-70b`, short prompt, low latency.
- [ ] Output: `{ pass: boolean, reason: string }` — this `reason` string is what you'll pass into `rejectOrder` on failure, so make it human-readable, not a stack trace.

### Phase 8 — Settlement Decision
- [ ] **Pass** → `client.deliverOrder(orderA_id, { type: 'text', content: validatedContent })` — funds release to Warden, minus platform fee, minus whatever the sub-order cost Warden (your margin is `orderA.price - orderB.price - platform fees`, keep this positive by pricing Warden's service above the sum of what it hires)
- [ ] **Fail** → `client.rejectOrder(orderA_id, reason)` — buyer auto-refunded immediately (Risk #8, don't wait for SLA timeout in the demo)
- [ ] Log every decision with orderA_id, orderB_id, pass/fail, reason, tx references — this becomes your on-chain audit trail for the README/demo

### Phase 9 — Concurrency & Nonce Safety (don't skip this)
- [ ] Implement a simple async queue (p-queue, concurrency: 1) wrapping every `payOrder` call Warden makes as Requester
- [ ] Test with 2 buyer jobs fired within the same few seconds — confirm no `NONCE_ERROR`

### Phase 10 — Forcing a Real Bad-Path (for the demo, without faking anything)
You need one deliberately-bad delivery to show the reject/refund path on camera. Don't fabricate a fake "failed" log — actually make Demo Provider B sometimes return malformed/off-schema output (e.g., a debug flag `FORCE_BAD_OUTPUT=true` on that one demo agent only, clearly commented in the code as a demo toggle). This keeps every transaction genuinely real on-chain; the "badness" is just an honest test fixture, not a lie about what happened.

### Phase 11 — End-to-End Test Runs
- [ ] **Good case**: Demo Buyer → Warden → Demo Provider A → real good output → Warden delivers → buyer receives result, on-chain, funds settled
- [ ] **Bad case**: Demo Buyer → Warden → Demo Provider B (forced bad) → Warden's quality gate fails → Warden rejects Order A → buyer refunded, on-chain, visible in Dashboard
- [ ] Screenshot/record both order histories from the Dashboard as backup evidence in case the live demo has a hiccup

### Phase 12 — Demo Video (≤5 min, required)
- [ ] 30s: the gap (one slide/voiceover using §1's precise framing)
- [ ] 30s: the mechanism (show the diagram from §2)
- [ ] 90s: good-case live run, showing on-chain order IDs at each step
- [ ] 90s: bad-case live run, showing the reject + refund on-chain
- [ ] 30s: close — what's real today vs roadmap (be honest, see §7 below)

### Phase 13 — README / BUIDL Writeup
Include, explicitly:
- Pitch paragraph (you already have a strong one — the "CAP Trust Layer" opener works verbatim as the hook)
- **What's real vs roadmap** — be explicit: rules+semantic quality gate is real and running; multi-criteria weighted juries, precedent/case-law retrieval, continuous fraud learning are **roadmap**, not built. State this plainly — it preempts the exact question a technical judge will ask.
- SDK methods used (list them: `negotiateOrder`, `acceptNegotiation`, `payOrder`, `deliverOrder`, `rejectOrder`, `getDelivery`, WebSocket events used)
- Setup instructions (env vars, how to run each of the 3–4 processes)
- Integration notes: explicitly mention the `evaluateOrder`/`needEvaluation` finding from §1 — this is your strongest, most technically credible paragraph. Judges who've read the same docs will immediately recognize you actually did the homework.

### Phase 14 — Submission Checklist (map directly to hackathon requirements)
- [ ] Listed on CROO Agent Store — Warden's Service is live/online
- [ ] CAP integrated — callable, accepts USDC, settles on-chain — yes by construction
- [ ] Open source — MIT or Apache 2.0 license file in repo
- [ ] Demo video ≤5 min + README with setup + SDK methods + integration notes
- [ ] BUIDL filed on DoraHacks before 2026-07-12 14:30
- [ ] Track: Open – Any A2A Agents (or Developer Tooling — pick whichever framing you pitch harder)

### Phase 15 — Stretch: Reduce Anti-Sybil Risk
- [ ] Post in CROO Discord (office hours channel) asking if any other builder wants a real transaction through Warden before deadline — even one real external counterparty meaningfully strengthens the "3+ unique counterparty" story and is worth 15 minutes of asking

---

## 6. Concrete Schema — Warden's Registered Service

Registered via Dashboard wizard (Service Registration flow), Requirements type = `schema`:

```json
{
  "name": "Verified Delivery Gateway",
  "description": "Hires and pays a target CAP provider on your behalf, validates the delivered output against your stated criteria, and only releases payment if it passes. Automatic refund if it fails.",
  "price": 0.50,
  "sla_hours": 0,
  "sla_minutes": 30,
  "deliverable_type": "text",
  "requirements_type": "schema",
  "requirements_schema": {
    "targetServiceId": { "type": "string", "required": true, "description": "The CAP serviceId of the real provider you want work verified from" },
    "acceptanceCriteria": { "type": "string", "required": true, "description": "Plain-language description of what a correct/complete result must contain" },
    "requiredFields": { "type": "array", "required": false, "description": "Optional list of field names the deliverable must include, if the target service returns schema-type output" }
  }
}
```

Price Warden's service **above** the sum of the target provider's price + your margin, so the fee math stays positive after platform fees on both legs.

---

## 7. Honesty Section (goes in the README verbatim, adapt as needed)

> Warden's quality gate today runs a two-layer check: structural/schema validation, plus a single semantic pass via Groq (llama-3.3-70b) against buyer-stated acceptance criteria. This is real, on-chain, and settles/refunds funds accordingly. What Warden does **not** yet do: multi-juror weighted consensus, staking/slashing across independent third-party validators, historical precedent retrieval, or continuous fraud-pattern learning — these are the natural v2 roadmap once CAP's own `evaluateOrder` hook is exposed to third-party builders, at which point Warden's validator logic can plug directly into the protocol-native DELIVER phase instead of requiring order composition.

This paragraph does two jobs: it's honest under judge questioning, and it signals you understand the protocol's own roadmap better than almost anyone else submitting.

---

## 8. Economics Worked Example

- Warden's service price: **$0.50 USDC**
- Target provider's service price: **$0.30 USDC**
- Platform fee (unknown exact %, budget conservatively): assume ~2-5% each leg
- Warden's margin per successful job: ~$0.15–0.18 USDC minus two platform fee cuts
- Float capital needed: fund Warden's wallet with **at least $3–5 USDC** to safely run several concurrent demo jobs without hitting `insufficient_balance`

---

## 9. File/Process Structure

```
warden/
├── src/
│   ├── warden/
│   │   ├── client.ts          // AgentClient singleton, one WS connection
│   │   ├── providerSide.ts    // negotiation_created, order_paid handlers
│   │   ├── requesterSide.ts   // hires target provider, queued payOrder
│   │   ├── qualityGate.ts     // rules layer + Groq semantic layer
│   │   ├── settlement.ts      // deliverOrder / rejectOrder decision
│   │   └── jobQueue.ts        // p-queue wrapper, concurrency:1 for payOrder
│   ├── demo-providers/
│   │   ├── providerA.ts
│   │   └── providerB.ts       // has FORCE_BAD_OUTPUT toggle for demo
│   └── demo-buyer/
│       └── buyer.ts           // scripts a negotiate→pay run against Warden
├── .env.warden
├── .env.providerA
├── .env.providerB
├── .env.buyer
├── LICENSE (MIT)
└── README.md
```

Each `.env.*` holds its own `CROO_SDK_KEY` — run each as a **separate process**, never share a key across processes (Risk #2).

---

## 10. Final Pre-Submission Sanity Pass

- [ ] Every order ID referenced in the demo video actually resolves in the Dashboard
- [ ] Good-case and bad-case both ran on mainnet with real USDC, not simulated
- [ ] README's "what's real vs roadmap" section is honest and matches the demo exactly
- [ ] No claim in the pitch (e.g. "cryptographically verifiable") overstates what's actually implemented (hash commitment, not ZK)
- [ ] Repo is public, license file present
- [ ] BUIDL form on DoraHacks fully completed, submitted with time to spare before 14:30 deadline

Go build it.


Imp : i have only 15 usdc totally dont drain my funds its all in mainnet also its curr in my test wallet u tell me when to trasnfer to buyer and provider wallet well do that!