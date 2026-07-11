# Warden — Command Cheat Sheet

All commands run from `backend/`:

```bash
cd /Users/austinjeremiah/Desktop/Hacks/warden/backend
```

---

## Run the demo (2 terminals)

**Terminal A — services (leave running the whole demo):**
```bash
npm run agents          # starts Provider A + Provider B + Warden
```
Wait until you see all three `online`.

**Terminal B — fire ONE scenario at a time:**
```bash
npm run buyer -- code       # GOOD code  -> Docker tests pass -> escrow released
npm run buyer -- codebad    # BAD code   -> sandbox fails      -> buyer refunded
npm run buyer               # GOOD text  -> policies pass       -> delivered
npm run buyer -- bad        # BAD text   -> `contains` fails    -> refunded
```

Each scenario takes ~2–4 min (on-chain confirmations). Watch **Terminal A** for
Warden's decisions and **Terminal B** for the buyer's outcome.

---

## ⭐ Golden rule: stop with Ctrl+C

Stop the agents with **`Ctrl+C`** in Terminal A. Never close the terminal or
hard-kill — `Ctrl+C` releases the WebSocket cleanly so the next `npm run agents`
connects instantly.

---

## If you see `ERROR ... duplicate key` (stuck sessions)

This means a previous agent process is still holding a key (usually a hard-kill or
a terminal that was closed instead of Ctrl+C). Fix:

```bash
npm run stop            # force-kill any lingering agent processes
# wait ~80 seconds for CROO to release the WebSocket sessions
npm run check           # verify all 4 keys connect cleanly (expect 4/4)
npm run agents          # start clean
```

`npm run check` is safe to run anytime — it connects each key, confirms, and
closes gracefully.

---

## Utilities

```bash
npm run check           # verify all 4 agents connect (4/4 expected)
npm run balances        # on-chain USDC balances of all 4 agent wallets
npm run stop            # force-stop lingering agent processes
```

## Offline proofs (no funds, no chain)

```bash
npm run test:policies   # policy engine: good passes, off-topic fails, etc.
npm run test:sandbox    # Docker sandbox: good passes, buggy fails, malicious BLOCKED
```

---

## Wallets (Base mainnet)

| Agent | AA wallet |
|---|---|
| Warden | `0xcA01B52ca180E888Fa3B6AF996925F8d71e25D72` |
| Provider A | `0xb8131746E68465141BDA5D02E7225C9b431b95a5` |
| Provider B | `0x7e8c48E405003A958c1036db11ce892542514a06` |
| Buyer | `0x585144E4479C594B04d0E9D9F7799156f6b06435` |

USDC (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
Recover funds anytime via the **Withdraw** button on each agent's dashboard card.
