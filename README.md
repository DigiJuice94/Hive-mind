# HIVE AUDITOR V1.2

This version adds the Update Prompt Engine on top of the live learning dashboard. HIVE is no longer a money-making bot and it is not a trading Council seat.

## Mission

HIVE independently monitors the live Bot Council and audits the infrastructure underneath trading. It is designed to answer four questions continuously:

1. Did the Council record a BUY even though executable liquidity was zero or could not be independently trusted?
2. Did the PAPER ledger credit sale proceeds when no executable sell route was actually verified?
3. Do cash, open position value, equity, realized P/L and locked-capital losses reconcile?
4. Is a technical/background failure corrupting the Council's state, logs or accounting?

HIVE may diagnose an infrastructure problem, develop a code repair, validate that protected trading logic was not changed, and produce a downloadable Council ZIP. It never auto-deploys the repair.

## Hard strategy boundary

HIVE is not allowed to change Council votes, BUY/WATCH/SKIP logic, entry score thresholds, position sizing strategy, take-profit rules, trailing logic, stop rules, risk appetite, agent prompts, learned trading strategy or token selection.

The protected strategy files are hard-coded into HIVE. In mixed infrastructure files, protected functions are hash-checked before an update is packaged.

## Live target

Default Council URL:

`https://bot-council-production.up.railway.app`

Override with Railway variable:

`COUNCIL_URL`

HIVE polls the Council roughly every 30 seconds. It reads the live autopilot status, trade log, lightweight position feed and read-only Proof/Rug cabinets. If one endpoint is unavailable it falls back to the others.

## Important finding already encoded from the supplied Council baseline

The uploaded Council source contains a path where route-feasibility live verification is limited to Solana BUY orders while forced PAPER exits can still compute modeled proceeds. HIVE treats this as a critical execution/accounting weakness because a simulated SELL should not become verified cash solely from a model when no reverse route was proven.

The supplied entry pipeline also explicitly notes that pool reserve does not prove sellability. HIVE watches whether PAPER buys are being recorded without adequate execution evidence while preserving the Council's original BUY decision.

## Repair engine

Monitoring does **not** require an AI API.

Only the repair engineer needs a reasoning provider. HIVE can use any one or more of:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`

Default order: Gemini -> Groq -> OpenRouter -> OpenAI. Override with `HIVE_PROVIDER_ORDER`.

Repairs are produced as exact search/replace operations against the owner-supplied `council-baseline.zip`. HIVE validates the changed TypeScript syntax, verifies protected strategy functions did not change, and packages a full Council ZIP into its Update Center.

## Railway deployment

Upload these files to a new HIVE Auditor GitHub repository:

- `server.js`
- `package.json`
- `railway.json`
- `.gitignore`
- `README.md`
- `council-baseline.zip`

Deploy that repository as its own Railway service. The Council remains a separate Railway service.

For durable history and downloadable updates across HIVE redeploys, attach a Railway Volume at `/data`. HIVE automatically uses `/data/hive-auditor` when the mount exists.

Optional variables:

- `HIVE_POLL_MS=30000`
- `HIVE_AUTO_REPAIR=true`
- `HIVE_REPAIR_COOLDOWN_MS=21600000`
- `HIVE_DATA_DIR=/data/hive-auditor`

## Local verification

`npm test`

The built-in self-test verifies that HIVE catches an equity mismatch, a zero-liquidity BUY, an unverified credited SELL and incorrect unsellable accounting.

## Update behavior

When HIVE has a verified repair and its guards pass, the dashboard shows **UPDATE READY** with a download button. HIVE does not silently modify the live Council. The owner decides when to deploy the package.


## V1.1 live learning dashboard

The homepage now visibly shows what HIVE is learning from the live Bot Council instead of the old HIVE ZERO "Learn to do the work" screen.

HIVE files persistent audit lessons from:

- newly observed Council fills
- BUY-side entry-liquidity evidence
- SELL route-verification coverage
- proof-cabinet equity reconciliation
- unsellable positions and locked-capital loss
- live endpoint coverage and state changes

The dashboard separates **learning** from **trading strategy**. These lessons are about system truthfulness and infrastructure correctness only. A new read-only endpoint is available at `/api/learning`.


## V1.2 Update Prompt Engine

HIVE now converts verified live infrastructure weaknesses into copy-ready prompts for repairing the **current** Bot Council build.

This does **not** require an AI key. The prompt is generated deterministically from HIVE's own live findings and includes:

- finding type and severity
- distinct live incidents and repeated observations
- concrete fill/position evidence from the live Council
- HIVE's current root-cause hypothesis
- likely infrastructure files to inspect
- a hard strategy lock stating what must not change
- required repair behavior
- acceptance criteria
- regression tests
- instructions to use the user's attached **current Bot Council ZIP** as source of truth
- instructions to return one clean downloadable updated Council package

The dashboard now has an **UPDATE PROMPTS** section with **COPY PROMPT** and **DOWNLOAD .TXT** controls.

A key example is `UNVERIFIED_SELL_CREDIT`. When HIVE sees recurring SELL fills where `filledUsd > 0` but `routeVerified !== true`, it generates a prompt specifically requiring the current Council build to stop modeled/unverified exits from becoming realized cash while preserving the Council's original EXIT decision and all trading strategy.

Read-only endpoints:

- `/api/prompt/<PROMPT_ID>` returns the generated prompt as JSON.
- `/prompt/<PROMPT_ID>` returns plain text.
- `/prompt/<PROMPT_ID>?download=1` downloads the prompt as a `.txt` file.

The existing optional Repair Engine remains available, but the Update Prompt Engine is designed for the owner's preferred workflow: **HIVE audits live -> HIVE verifies a recurring weakness -> HIVE prepares a precise prompt -> owner attaches the latest Council ZIP and gives that prompt to ChatGPT -> ChatGPT creates the candidate update.**
