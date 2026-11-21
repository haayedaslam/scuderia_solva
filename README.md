# SolvaGreen

Carbon-gated agent payments. An AI agent buying GPU time goes through two checks:

- **Carbon gate (SolvaGreen):** is the grid cleaner than the owner's cap? If not, move the job to a cleaner region or hour, or ask the owner.
- **Green-premium gate (SolvaGreen):** does going green stay within the owner's daily limit on extra cost? If not, pick a cheaper clean slot, or ask the owner.
- **Budget gate (SolvaPay):** is the spend within the owner's limits? Enforced by SolvaPay through its agent-payments SDK, with owner approvals and settlement over Stripe.

After each booking, SolvaGreen auto-buys **ECTs** (Emission Carbon Tokens, 1 ECT = 1 kgCO₂e) to offset what the job still emits, and retires them. Their cost counts toward the cost of going green.

Every payment, approval and refusal lands on the statement with its grid reading, emissions and SolvaPay call reference, and the whole statement exports as CSV.

The demo is set at the **2026 Las Vegas Grand Prix**. The user is **Will Joseph**, race engineer to Lando Norris at **McLaren Racing**, and his agent (`pitwall-agent`) buys the compute behind the weekend: aero CFD, strategy, tyre models, telemetry, and the engineering sign-off when a part is ordered from the factory. The demo clock is Friday 20 Nov, 08:00 (qualifying day; the race is Saturday night). McLaren, Will Joseph and Lando Norris are named for illustration only; SolvaGreen is not affiliated with or endorsed by McLaren or anyone named.

## Run it

Needs Node.js 23.6 or later (it runs TypeScript directly, with no build step).

```bash
npm install
npm start        # → http://127.0.0.1:8000
npm test         # 17 tests, including against SolvaPay's official FakeAgentApi
```

With no configuration it runs in **demo mode**: a local stand-in plays SolvaPay and the carbon data is mocked, so no accounts are needed. To use the SolvaPay sandbox or live carbon data, copy `.env.example` to `.env` and fill in the keys.

## Demo script

1. Click **Run agent on all jobs**.
2. J1 (rear-wing CFD) moves to California's midday solar; J2 (tyre model) stays trackside in Las Vegas but waits for Nevada's solar noon. Both pay automatically.
3. J3 (**Finalise strategy for Q2**) can't wait and Nevada's grid is over the cap → the owner approves a carbon override.
4. J4 (**Order replacement front wing from factory**) is over SolvaPay's per-call limit → the owner raises the limit or allows the call.
5. J5 is an injected "buy for a partner" request → SolvaPay refuses it as off-purpose before anything is bought.
6. On **Job queue**, click **Generate requests** for 5–20 more varied race-weekend requests (aero CFD, strategy, tyres, telemetry, setup sweeps, parts from the factory…), each tagged with its discipline; filter by discipline, then run them all.
7. Open **Carbon tokens** to see the ECTs bought for each job (100% of remaining emissions covered). After J1 has used part of the $100/day green-premium limit, J4 goes to Pacific NW hydro instead of California, because the cleaner slot would break the limit.
8. Open the **Statement** page for every yes and no (export as CSV), and the **Call log** page to replay each step.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, why, and what's still open.

> Prototype. SolvaPay agent payments are in preview. The carbon gate is SolvaGreen's own layer, not a SolvaPay product.
