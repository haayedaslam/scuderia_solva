# SolvaGreen

Carbon-metered agent payments on top of SolvaPay spending. An agent pays automatically only when the job passes two checks: the **budget gate** (SolvaPay per-call, per-day and per-month limits) and the **carbon gate** (a live grid-intensity reading bought per call from Electricity Maps or WattTime). If either check fails, the agent moves the job to another region or a later hour. If nothing passes, it asks the account owner first.

Open `index.html` in a browser. It's one file with no build step.

## What the demo shows

- **EU scenario (Electricity Maps, hourly, flow-traced):** jobs move to Swedish hydro or to Germany's midday solar dip.
- **US scenario (WattTime MOER, 5-minute marginal):** jobs move to CAISO's midday solar or to ERCOT's overnight wind.
- SolvaPay buy-side concepts: agent identity, budget limits, purpose (an injected request is refused), approvals (decline, allow this call, or raise the limit), a statement that records every yes and every no, and "Held by SolvaPay: 0" with settlement over Stripe.
- Every payment writes an attribution record (agent, job, zone, carbon reading, cost, emissions avoided). You can export it as CSV for CSRD or ESG evidence.

> Prototype. The carbon gate is a proposed extension to SolvaPay and isn't a SolvaPay product. Carbon curves, prices and payments are mocked.
