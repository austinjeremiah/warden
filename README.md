# Warden — Programmable Quality-Gated Escrow for CAP

> **CAP moves money when work is _delivered_. Warden moves money only when work _satisfies programmable quality policies_.**

CAP standardizes negotiation, escrow, delivery, and settlement — but once a Provider calls `deliverOrder`, funds release automatically with **zero Requester approval**. Warden is a CAP-native agent that sits between buyer and provider as **both Provider and Requester simultaneously**, and releases escrow only when the delivery satisfies a **pluggable bundle of quality policies** attached to the order — using nothing but composed Orders, escrow, and the existing reject/refund path. No invented protocol features. No dispute state that doesn't exist. Just correct use of what CAP already ships.

Warden is **domain-agnostic**: quality isn't hardcoded, it's a data-driven policy bundle. A policy might require a JSON schema, a substring/citation, a regex format, a minimum length, a semantic match against buyer criteria — or, at the strongest end, **the delivered code passing the buyer's own test suite, executed inside a hardened sandbox.** For code work, "quality" stops being an opinion and becomes a fact:

> **Warden releases escrow only when the delivered code provably passes the buyer's tests — verified by execution, not judgment.**

**Live on CROO:** [agent.croo.network/agents/f09fc9fc…08d5](https://agent.croo.network/agents/f09fc9fc-f55b-44da-985c-024e81fe08d5) · **Base Mainnet** (chain 8453) · **real USDC** (no testnet) · gas sponsored via the Paymaster.

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
| `code_tests` | **runs the delivered code against the buyer's test suite inside a hardened Docker sandbox** — escrow releases only if every test passes (objective, not an opinion) |

### `code_tests`: verifiable execution (the strongest policy)

Warden runs **untrusted code from an anonymous provider** and lets the result move real money — so the sandbox is locked down on every axis (`src/warden/sandbox.ts`):

- `--network=none` — no network (can't exfiltrate Warden's wallet key)
- `--read-only` + `--tmpfs` — immutable root filesystem, tiny writable scratch only
- `--user 65534:65534` — non-root (nobody)
- `--memory`/`--cpus`/`--pids-limit` — no memory bomb, CPU hog, or fork bomb
- `--cap-drop ALL` + `--security-opt no-new-privileges` — no Linux caps, no privilege escalation
- host-side kill timer — hard wall-clock timeout even if Docker hangs
- fresh temp workdir per job, bind-mounted read-only, destroyed after

Verified offline (`npm run test:sandbox`): correct code passes, buggy code fails the specific test, and **code that tries to open a network socket is blocked** (`Network is unreachable`).

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

Run the offline proof (no funds, no chain): `npm run test:policies`.

---

## What's real vs roadmap (read this)

**Real, on-chain, settles/refunds real USDC today:**
- Two-order composition (Warden as Provider + Requester in one process)
- Pluggable policy engine — structural, substring/regex, JSON-schema, semantic (Groq), and **executable `code_tests`** run in a hardened Docker sandbox
- Pass → `deliverOrder` (release), Fail → `rejectOrder` (refund); immediate reject on provider failure
- Nonce-safe serialized `payOrder` queue (one in-flight wallet tx at a time) and a single WebSocket per API key

**Roadmap — NOT built:**
- More policy evaluators: verify an image at a target resolution, check that cited URLs resolve, call an external oracle, multi-language sandboxes
- Auto-remediation (retry / provider failover before refund) and best-of-N provider routing
- Multi-juror weighted consensus / staking / slashing across independent validators
- Historical precedent / case-law retrieval; continuous fraud-pattern learning

The policy engine is the extensibility surface: each of the above is a new evaluator registered in `policies.ts`, no core change. These are the natural v2 once CAP exposes `evaluateOrder` to third-party builders — at which point Warden's policy engine plugs directly into the protocol-native DELIVER phase instead of requiring order composition.

**Honest caveats:** Deliverable integrity is a **keccak256 hash commitment** written on-chain — tamper-evident, *not* a zero-knowledge proof. Warden **absorbs the sub-order cost on a rejected job** (as Requester on B it cannot reject B's delivery — only the provider can; this is the honest economic cost of protecting the buyer). Demo providers and buyer are **our own seed agents**, disclosed as such.

---

## Proven live on Base Mainnet (real USDC)

Both paths ran end-to-end with real settlement:

- **Good path (text)** — Order A `4a0c11d9` → `completed`. Provider A delivered a real summary, Warden's 4 policies passed, escrow released to Warden. Deliver tx `0x922b…7515`, clear tx `0x387a…d839`.
- **Bad path (text)** — Order A `9f1c2e15` → `rejected`. Provider B delivered off-topic text, Warden's gate failed on `policy: contains`, Order A rejected, **buyer refunded**. Reject tx `0x12c8…a389`.
- **Good path (code)** — Order A `f1d73efd` → `completed`. Provider A wrote a real `is_palindrome`, **Warden ran it against the buyer's 5 tests in a Docker sandbox → all passed → escrow released.** Deliver tx `0xce95…15e4`.
- **Bad path (code)** — Order A `c7fa2b0b` → `rejected`. Provider B delivered non-code, **the sandbox load failed (`SyntaxError`) → `policy: code_tests` failed → buyer refunded.** Reject tx `0xf123…7f4f`.

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
│   ├── client.ts      # AgentClient factory — one client / one WebSocket per key
│   ├── payQueue.ts    # p-queue concurrency:1 — serializes payOrder (nonce safety)
│   └── groq.ts        # thin Groq chat wrapper
├── warden/
│   ├── index.ts       # orchestrator: both roles on one WS, routes by job id
│   ├── jobStore.ts    # in-memory job ledger, indexed by order/negotiation ids
│   ├── policies.ts    # pluggable policy registry + evaluatePolicies engine
│   ├── sandbox.ts     # hardened Docker runner for the code_tests policy
│   ├── qualityGate.ts # builds the policy bundle + runs the engine
│   └── settlement.ts  # deliver/reject decision + on-chain audit log
├── demo-providers/
│   ├── providerBase.ts # shared provider runtime (Groq task)
│   ├── providerA.ts    # GOOD path
│   └── providerB.ts    # BAD path (FORCE_BAD_OUTPUT demo toggle)
├── demo-buyer/
│   └── buyer.ts        # hires Warden; modes: good | bad | code | codebad
└── scripts/
    ├── agents.ts       # launcher: Provider A + B + Warden in one terminal
    ├── checkAgents.ts  # verify all agents connect (read-only)
    ├── balances.ts     # on-chain USDC balances of the agent wallets
    ├── testPolicies.ts # offline policy-engine proof
    ├── testSandbox.ts  # offline sandbox proof (good / buggy / malicious)
    └── smoke.ts        # connectivity smoke test
```

---

## Setup

Requires Node 18+, four registered CROO agents (Warden, Provider A, Provider B, Buyer), and — for the `code_tests` policy — Docker with the `python:3.11-slim` image (`docker pull python:3.11-slim`).

```bash
cd backend
npm install
cp .env.example .env    # then fill in real keys/wallets/serviceIds + GROQ_API_KEY
```

Each agent = its **own** API key. Fund the **agent AA wallets** (not the account wallet, not the controller). Because CAP uses a **USDC paymaster**, gas is paid in USDC from the sending wallet — so every agent that submits a transaction needs a small USDC balance:
- **Buyer** — order price + gas
- **Warden** — float to pay Order B before Order A releases, + gas
- **Provider A / B** — a small gas float (they submit `acceptNegotiation` and `deliverOrder`); ~0.1 USDC each is plenty

### Run

Start the three services in one terminal, then drive them from another:

```bash
npm run agents            # starts Provider A + Provider B + Warden (one terminal)
```

```bash
npm run buyer             # GOOD (text) — policies pass → delivered
npm run buyer -- bad      # BAD  (text) — `contains` fails → refunded
npm run buyer -- code     # GOOD (code) — code passes sandbox tests → released
npm run buyer -- codebad  # BAD  (code) — non-code fails sandbox → refunded
```

Services can also be run individually: `npm run warden`, `npm run providerA`, `npm run providerB`.

Offline proofs (no funds, no chain): `npm run test:policies` and `npm run test:sandbox` (the latter needs Docker). Verify connectivity with `npm run check`; inspect balances with `npm run balances`.

> **One WebSocket per API key.** Never run two processes with the same key. Stop services with `Ctrl+C` (graceful close); a hard kill leaves the session held server-side and the next start is rejected with close code 1008 until it times out.

---

## License

MIT — see [LICENSE](./LICENSE).
