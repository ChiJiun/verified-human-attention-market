import { describe, expect, it } from "vitest";

import type { CampaignRecord } from "../src/campaigns/types.js";
import { decodeCampaignManagerLog } from "../src/chain/abi.js";
import {
  InMemoryChainEventRepository,
  type IndexedEvent,
} from "../src/chain/events-repository.js";
import type { IssuedClaim } from "../src/claims/repository.js";
import { checkReconciliation } from "../src/reconciliation/check.js";
import { logs } from "./support/fake-chain.js";

const scope = { chainId: 84532, contractAddress: "0x" + "c0".repeat(20) };
const ADVERTISER = "0x" + "aa".repeat(20);
const ALICE = "0x" + "a1".repeat(20);
const MALLORY = "0x" + "66".repeat(20);
const USDC = 1_000_000n;
const nonceHex = (value: number) =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}`;

const campaign = {
  id: "11111111-1111-4111-8111-111111111111",
  onchainCampaignId: "1",
} as CampaignRecord;

function event(
  spec: { topics: string[]; data: string },
  block: number,
  index: number,
): IndexedEvent {
  const decoded = decodeCampaignManagerLog({
    topics: spec.topics,
    data: spec.data,
  });
  if (!decoded) throw new Error("undecodable test log");
  return {
    txHash: `0x${String(block).padStart(4, "0")}${String(index).padStart(60, "0")}`,
    logIndex: index,
    blockNumber: BigInt(block),
    blockHash: `0x${String(block).padStart(64, "0")}`,
    event: decoded,
  };
}

/** campaigns(id) struct as the contract would return it. */
function struct(values: {
  funded: bigint;
  paid: bigint;
  paidCompletions: number;
}) {
  const word = (value: bigint | number) =>
    BigInt(value).toString(16).padStart(64, "0");
  return `0x${[
    word(BigInt(ADVERTISER)),
    word(values.funded),
    word(values.paid),
    word(USDC),
    word(10),
    word(values.paidCompletions),
    word(1),
    word(2),
    word(0),
    word(1),
  ].join("")}`;
}

async function setup(options: {
  events: IndexedEvent[];
  contract: { funded: bigint; paid: bigint; paidCompletions: number } | "down";
  issued: IssuedClaim[];
}) {
  const events = new InMemoryChainEventRepository();
  await events.commitConfirmedRange(
    scope,
    { from: 1n, to: 20n, toBlockHash: `0x${"20".padStart(64, "0")}` },
    options.events,
  );
  const calls: (bigint | undefined)[] = [];

  return {
    calls,
    run: () =>
      checkReconciliation({
        campaigns: { listLinked: async () => [campaign] },
        events,
        claims: { listIssuedClaims: async () => options.issued },
        rpc: {
          call: async (_to: string, _data: string, block?: bigint) => {
            calls.push(block);
            if (options.contract === "down") throw new Error("rpc down");
            return struct(options.contract);
          },
        },
        chain: scope,
      }),
  };
}

const baseEvents = () => [
  event(logs.created(1, ADVERTISER), 2, 0),
  event(logs.funded(1, 10n * USDC), 3, 0),
  event(logs.claimed(1, ALICE, USDC, 7), 5, 0),
];

describe("settlement reconciliation (#29)", () => {
  it("is clean when contract, events and authorizations agree", async () => {
    const { run, calls } = await setup({
      events: baseEvents(),
      contract: { funded: 10n * USDC, paid: USDC, paidCompletions: 1 },
      issued: [{ claimant: ALICE, nonce: nonceHex(7) }],
    });

    expect(await run()).toEqual({
      confirmedBlock: "20",
      campaignsChecked: 1,
      findings: [],
    });
    // Read at the confirmed block, not "latest".
    expect(calls).toEqual([20n]);
  });

  it("flags a payout the API never authorized (forged signature)", async () => {
    const { run } = await setup({
      events: [...baseEvents(), event(logs.claimed(1, MALLORY, USDC, 8), 6, 0)],
      contract: { funded: 10n * USDC, paid: 2n * USDC, paidCompletions: 2 },
      issued: [{ claimant: ALICE, nonce: nonceHex(7) }],
    });

    const report = await run();
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "UNBACKED_PAYOUT",
        campaignId: campaign.id,
      }),
    ]);
    expect(report.findings[0]!.detail).toContain(MALLORY);
  });

  it("flags a nonce mismatch for an otherwise known claimant", async () => {
    const { run } = await setup({
      events: baseEvents(),
      contract: { funded: 10n * USDC, paid: USDC, paidCompletions: 1 },
      issued: [{ claimant: ALICE, nonce: nonceHex(99) }],
    });

    expect((await run()).findings.map((finding) => finding.kind)).toEqual([
      "UNBACKED_PAYOUT",
    ]);
  });

  it("flags indexed state that disagrees with the contract", async () => {
    const { run } = await setup({
      // The indexer missed the claim event.
      events: baseEvents().slice(0, 2),
      contract: { funded: 10n * USDC, paid: USDC, paidCompletions: 1 },
      issued: [],
    });

    expect((await run()).findings).toEqual([
      expect.objectContaining({
        kind: "INDEX_MISMATCH",
        detail: "paidRewards: contract 1000000, indexed 0",
      }),
      expect.objectContaining({
        kind: "INDEX_MISMATCH",
        detail: "paidCompletions: contract 1, indexed 0",
      }),
    ]);
  });

  it("flags accounting violations and unreadable chain state", async () => {
    const { run } = await setup({
      events: [...baseEvents(), event(logs.refunded(1, 10n * USDC), 9, 0)],
      contract: "down",
      issued: [{ claimant: ALICE, nonce: nonceHex(7) }],
    });

    expect(
      (await run()).findings.map((finding) => finding.kind).sort(),
    ).toEqual(["ACCOUNTING_VIOLATION", "CHAIN_READ_FAILED"]);
  });
});
