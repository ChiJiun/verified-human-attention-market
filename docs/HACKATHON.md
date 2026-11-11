# Submission summary

[English](HACKATHON.md) | [繁體中文](HACKATHON.zh-TW.md)

A short description of the project, written to be pasted into a submission form. Every sentence can be checked against this repository; the [README](../README.md) links the evidence.

## To be filled in by the owner

| Field | Value |
| --- | --- |
| Hackathon and track | _to be filled in_ |
| Team | _to be filled in_ |
| Demo video | _to be filled in_ |
| Work done during the event | _to be filled in_ |
| Use of AI tools | _to be filled in_ |

## Description

**One-liner.** A testnet proof of concept where advertisers escrow USDC on-chain and each World ID-verified unique human is paid once per campaign for completing a sponsored-content comprehension check.

**Problem.** A wallet or a click is not a unique human. Campaign budgets can be claimed many times over by bots or by one person with many wallets.

**Solution.** World ID blocks a second claim per person per campaign without revealing who the person is. An off-chain verifier checks the answers and signs an EIP-712 authorization. The `CampaignManager` contract checks the signature, budget, completion cap, expiry and replay before paying, and returns the unused budget to the advertiser after the campaign closes and a waiting period passes.

**Tech.** Solidity and Foundry (unit, fuzz and stateful invariant tests), a Fastify API and chain indexer on PostgreSQL, Next.js, World ID IDKit, USDC on Base Sepolia.

**Status and next.** The full loop ran on Base Sepolia on 2026-10-14 with a real World ID proof (v1 contract). The contract has changed since, and the current version has run only on a local chain and in CI. Unaudited, test funds only, no real advertiser yet. Next: redeploy the updated contract, repeat the testnet run, then test with a real buyer.

**A limit worth stating.** The comprehension check is a baseline engagement signal, not proof of attention. World ID limits each person to one reward per campaign; it does not make the answers thoughtful.

## Where to look

| To see | Open |
| --- | --- |
| What is proven and what is not | [README: What is real today](../README.md#what-is-real-today) |
| The testnet transactions | [DEMO: the Base Sepolia run of 2026-10-14](DEMO.md#the-base-sepolia-run-of-2026-10-14) |
| The contract | [`packages/contracts/src/CampaignManager.sol`](../packages/contracts/src/CampaignManager.sol) and its tests in [`packages/contracts/test/`](../packages/contracts/test/) |
| The end-to-end test of the money loop | [`apps/api/e2e/poc.e2e.ts`](../apps/api/e2e/poc.e2e.ts) |
| How to run it | [README: Run it locally](../README.md#run-it-locally) and [DEMO](DEMO.md) |
| Why each decision was made | [docs/adr/](adr/README.md) |

Third-party technologies the project builds on: World ID (IDKit and backend verification of 4.0 proofs), Base (the Base Sepolia testnet), and USDC (Circle's test USDC on Base Sepolia).
