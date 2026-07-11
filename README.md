# Warden — Programmable Quality-Gated Escrow for CAP

> **CAP moves money when work is _delivered_. Warden moves money only when work _satisfies programmable quality policies_.**

CAP standardizes negotiation, escrow, delivery, and settlement — but once a Provider calls `deliverOrder`, funds release automatically with **zero Requester approval**. Warden is a CAP-native agent that sits between buyer and provider as **both Provider and Requester simultaneously**, and releases escrow only when the delivery satisfies a **pluggable bundle of quality policies** attached to the order — using nothing but composed Orders, escrow, and the existing reject/refund path. No invented protocol features. No dispute state that doesn't exist. Just correct use of what CAP already ships.

Warden is **domain-agnostic**: quality isn't hardcoded, it's a data-driven policy bundle. A policy might require a JSON schema, a substring/citation, a regex format, a minimum length, or a semantic match against buyer criteria. Warden simply executes the bundle attached to the order.

Built for the **CROO Agent Hackathon**. Runs on **Base Mainnet** with **real USDC** (chain 8453 — CAP has no testnet). Gas is sponsored via the Paymaster; agents hold only USDC.

---

## The gap Warden fills

Two CROO documents disagree, and it matters:

- The **whitepaper** describes a `Dispute` entity and "Verifier/Reviewer (Optional)" — arbitration for a failed Clear stage.
- The **Smart Contracts** doc shows the real on-chain state machine:

  ```
  NEGOTIATION ──[payOrder]──► LOCK ──[deliverOrder]──► DELIVER ──[evaluateOrder]──► CLEAR
  ```

`evaluateOrder` and a `needEvaluation` flag **exist at the contract level** — but `evaluateOrder` is **not exposed anywhere in the public Node.js SDK** (`@croo-network/sdk@0.2.1`). `deliverOrder` with the default `needEvaluation=false` skips DELIVER and goes straight to CLEAR, releasing escrow with no requester approval.

**CAP's own architecture already anticipates a verification gate before settlement — it just hasn't shipped public access to it.** Warden builds that guarantee **today, in userland**, by composing two ordinary Orders — proving out exactly the pattern CAP's contract layer is heading toward, with no protocol change and no invented state.

---

## Mechanism

```
                    Order A (buyer-facing)              Order B (sub-order)
Buyer ────negotiate──────► Warden ────negotiate──────► Real Target Provider
Buyer ────payOrder────────► [escrow A]
                              Warden ──payOrder─────────► [escrow B]
                                                Provider ──deliverOrder──►
                              Warden ◄──OrderCompleted (Requester-side push)
                              Warden: getDelivery(orderB) → run quality gate
                    ┌─────────────────────┴─────────────────────┐
                 PASS                                          FAIL
                    │                                            │
     deliverOrder(orderA, data) ──►               rejectOrder(orderA, reason) ──►
     escrow A releases to Warden                  escrow A auto-refunds to Buyer
```

Warden is **one agent, one wallet, one API key, one WebSocket** — it plays Provider on Order A and Requester on Order B from the same process, routing every event to its job by ID.

| Event received | Warden's role | Action |
|---|---|---|
| `NegotiationCreated` | Provider (A) | validate buyer requirements → `acceptNegotiation` (auto-creates Order A) |
| `OrderPaid` | Provider (A) | buyer funded escrow A → hire provider: `negotiateOrder` (Order B) |
| `OrderCreated` | Requester (B) | provider accepted → **queue-guarded** `payOrder(B)` |
| `OrderCompleted` | Requester (B) | provider delivered → `getDelivery(B)` → quality gate → settle A |
| `OrderExpired` / `OrderRejected` (on B) | Requester (B) | provider failed to deliver → `rejectOrder(A)` so buyer is refunded |

---

## The policy engine (what's real, running today)

The buyer attaches a **policy bundle** to the order. Warden executes it fail-fast against the delivery and releases escrow only if **every** policy passes. Adding a new domain = registering a new policy evaluator; the core never changes.

| Policy `type` | Checks |
|---|---|
| `min_length` / `max_length` | size bounds |
| `no_placeholder` | not empty / error / garbage (always prepended as a baseline guard) |
| `contains` / `not_contains` | required / forbidden substring (e.g. a citation) |
| `regex` | pattern / format match |
| `json_valid` | parses as JSON |
| `json_fields` | JSON contains non-empty required fields |
| `semantic` | one Groq call (`llama-3.3-70b-versatile`) judging the delivery against buyer criteria; **fails closed** if the judge is unreachable |

Example bundle a buyer sends in the order requirements:

```json
{
  "targetServiceId": "a4f6520b-...",
  "input": "Summarize the following text in one sentence: ...",
  "policies": [
    { "type": "min_length", "min": 20 },
    { "type": "contains", "value": "Webb" },
    { "type": "semantic", "criteria": "A one-sentence, on-topic, factual summary." }
  ]
}
```

Output is `{ pass, reason, policy }` — `policy` names the deciding policy. On failure, `reason` is a human-readable string passed directly into `rejectOrder`. (Legacy `acceptanceCriteria` + `requiredFields` are still accepted and auto-synthesized into a bundle.)

Run the offline proof (no funds, no chain): `npx tsx src/scripts/testPolicies.ts`.

---

## What's real vs roadmap (read this)

**Real, on-chain, settles/refunds real USDC today:**
- Two-order composition (Warden as Provider + Requester in one process)
- Structural + semantic quality gate
- Pass → `deliverOrder` (release), Fail → `rejectOrder` (refund), immediate reject on provider failure
- Nonce-safe serialized `payOrder` queue (Risk #3), single WS per key (Risk #2)

**Roadmap — NOT built:**
- Richer policy evaluators: run a passing test suite, verify an image at a target resolution, check citations resolve, call an external oracle
- Multi-juror weighted consensus / staking / slashing across independent validators
- Historical precedent / case-law retrieval
- Continuous fraud-pattern learning

The policy engine is the extensibility surface: each of the above is a new evaluator registered in `policies.ts`, no core change. These are the natural v2 once CAP exposes `evaluateOrder` to third-party builders — at which point Warden's policy engine plugs directly into the protocol-native DELIVER phase instead of requiring order composition.

**Honest caveats:** Deliverable integrity is a **keccak256 hash commitment** written on-chain — tamper-evident, *not* a zero-knowledge proof. Warden **absorbs the sub-order cost on a rejected job** (as Requester on B it cannot reject B's delivery — only the provider can; this is the honest economic cost of protecting the buyer). Demo providers and buyer are **our own seed agents**, disclosed as such.

---

## Proven live on Base Mainnet (real USDC)

Both paths ran end-to-end with real settlement:

- **Good path** — Order A `4a0c11d9` → `completed`. Provider A delivered a real summary, Warden's 4 policies passed, escrow released to Warden. Deliver tx `0x922b…7515`, clear tx `0x387a…d839`.
- **Bad path** — Order A `9f1c2e15` → `rejected`. Provider B delivered off-topic text, Warden's gate failed on `policy: contains`, Order A rejected, **buyer refunded**. Reject tx `0x12c8…a389`.

Full tx list in [finished.md](./finished.md).

### Integration notes (gotchas found while building)
- **The Paymaster is a USDC paymaster.** Gas is sponsored, but paid *in USDC* from the agent's own wallet — so *every* agent wallet (including providers that only "receive") needs a small USDC balance, or `acceptNegotiation`/`deliverOrder` fail with `PIMLICO_ERROR: sender has no balance of the token for ERC20 sponsorship`.
- **`negotiateOrder` requirements must be valid JSON**, regardless of the service's declared requirements type.
- **The requester pays only `price`**; the platform `feeAmount` is settled separately, not added on top of the pay amount.
- **`evaluateOrder`/`needEvaluation` finding:** confirmed absent from the public SDK — `deliverOrder` (default `needEvaluation=false`) goes straight to CLEAR with no requester approval, which is exactly the gap Warden closes via order composition.

## SDK surface used (`@croo-network/sdk@0.2.1`)

**Methods:** `negotiateOrder`, `acceptNegotiation`, `rejectNegotiation`, `getNegotiation`, `payOrder`, `deliverOrder`, `rejectOrder`, `getDelivery`, `getOrder`, `connectWebSocket`.

**Events:** `order_negotiation_created`, `order_created`, `order_paid`, `order_completed`, `order_rejected`, `order_expired`.

---

## Architecture

```
backend/src/
├── shared/
│   ├── env.ts         # env loader + shared CROO endpoints
│   ├── logger.ts      # tagged, colorized per-process logger (also SDK Logger)
│   ├── client.ts      # AgentClient factory — one client/one WS per key (Risk #2)
│   ├── payQueue.ts    # p-queue concurrency:1 — serialize payOrder (Risk #3)
│   └── groq.ts        # thin Groq chat wrapper
├── warden/
│   ├── index.ts       # orchestrator: both roles on one WS, routes by job id
│   ├── jobStore.ts    # in-memory job ledger, indexed by order/negotiation ids
│   ├── policies.ts    # pluggable policy registry + evaluatePolicies engine
│   ├── qualityGate.ts # builds the policy bundle + runs the engine
│   └── settlement.ts  # deliver/reject decision + on-chain audit log
├── demo-providers/
│   ├── providerBase.ts # shared provider runtime (Groq task)
│   ├── providerA.ts    # GOOD path
│   └── providerB.ts    # BAD path (FORCE_BAD_OUTPUT demo toggle)
├── demo-buyer/
│   └── buyer.ts        # hires Warden; `npm run buyer` (good) / `-- bad`
└── scripts/
    └── smoke.ts        # connectivity smoke test
```

---

## Setup

Requires Node 18+ and four registered CROO agents (Warden, Provider A, Provider B, Buyer).

```bash
cd backend
npm install
cp .env.example .env    # then fill in real keys/wallets/serviceIds + GROQ_API_KEY
```

Each agent = its **own** API key. Fund the **agent AA wallets** (not the account wallet, not the controller):
- **Buyer** agent wallet — to pay Order A
- **Warden** agent wallet — float, to pay Order B before Order A releases
- Providers receive only (no funding needed)

### Run (each is a separate process / terminal)

```bash
npm run providerA     # good-path provider
npm run providerB     # bad-path provider (FORCE_BAD_OUTPUT=true)
npm run warden        # the gateway
npm run buyer         # GOOD path  — routes Warden to Provider A
npm run buyer -- bad  # BAD path   — routes Warden to Provider B (forced-bad → refund)
```

> **One WebSocket per API key.** Never run two processes with the same key; kill the old one first (CAP boots the second with close code 1008).

---

## License

MIT — see [LICENSE](./LICENSE).
