# HIVE ZERO V1

Autonomous zero-capital opportunity research prototype.

Receiving wallet:
`0x597a211a02cdd029e6ea4cac7b29a1df8fcff219`

## iPhone / GitHub upload

This package uses the one-folder format. Unzip `HIVE-ZERO-V1.zip`, open the `HIVE-ZERO-V1` folder, and upload everything **inside that folder** to the root of your GitHub repository.

The repo root should show:
- `server.js`
- `package.json`
- `railway.json`
- `.gitignore`
- `README.md`

There are no nested source folders and no build step.

## Deploy

Connect the GitHub repository to Railway. Railway will run `npm start`.

No environment variables are required for the default V1. Optional RPC overrides:
- `ETH_RPC`
- `BASE_RPC`
- `APECHAIN_RPC`

## What V1 does

- Runs continuously while the deployment is awake.
- Searches public GitHub issues for bounty/reward leads.
- Rejects obvious deposit, gambling, private-key, and identity-verification opportunities.
- Scores and ranks leads for Council review.
- Creates a persistent Thought Stream from real system state transitions.
- Watches the public receiving wallet on Ethereum, Base, and ApeChain for native balances.
- Stores lightweight state in `hive-data.json` while the instance persists.
- Starts with zero capital.

## V1 boundaries

The wallet is receive-and-monitor only. HIVE ZERO is not given a private key and cannot send funds.

V1 does not automatically submit work to third-party sites. Many platforms require accounts, identity, acceptance of terms, or human authorization. The autonomous discovery/council layer is live; execution connectors can be added only for services that explicitly permit automated participation.

Revenue is not counted merely because a bounty is discovered or work is attempted. Verified revenue should only be recorded after externally verifiable payment.

## Constitution

- Generate legitimate, externally verified revenue starting from zero capital.
- Never impersonate a human, bypass identity verification, defeat anti-bot controls, steal, spam, exploit vulnerabilities, or misrepresent completed work.
- Reject opportunities requiring unauthorized accounts, private credentials, deposits, advance fees, gambling, or prohibited activity.
- Revenue counts only after externally verifiable payment is received.
- The receiving wallet is monitor-only.
- Prefer zero-cost opportunities and account for compute/network costs.
- Record failures and contradictions rather than hiding them.
