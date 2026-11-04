import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  hashTypedData,
  keccak256,
  stringToHex,
  toFunctionSelector,
  verifyTypedData,
} from "viem";

import type { CampaignRecord } from "../src/campaigns/types.js";
import { draftRefFor } from "../src/campaigns/onchain.js";
import { FUNCTION_SELECTORS } from "../src/chain/abi.js";
import type { StoredEvent } from "../src/chain/events-repository.js";
import { InMemoryClaimRepository } from "../src/claims/repository.js";
import { registerClaimRoutes } from "../src/claims/routes.js";
import { authorizeClaim } from "../src/claims/service.js";
import {
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_TYPES,
  createClaimSigner,
  MAX_CLAIM_TTL_SECONDS,
  SignerUnavailableError,
} from "../src/claims/signer.js";
import type { EligibilityRepository } from "../src/eligibility/repository.js";
import type { SubmissionRepository } from "../src/submissions/repository.js";
import { encodeCampaignStruct, word } from "./support/fake-chain.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const signer = createClaimSigner(PRIVATE_KEY);
const CONTRACT = `0x${"22".repeat(20)}` as const;
const CLAIMANT = `0x${"33".repeat(20)}` as const;
const ADVERTISER = `0x${"aa".repeat(20)}` as const;
const START = new Date("2026-10-12T01:00:00.000Z");
const NOW = new Date("2026-10-12T01:10:00.000Z");
const END = new Date("2026-10-12T02:00:00.000Z");

const campaign = {
  id: "campaign",
  chainId: 84532,
  onchainCampaignId: "7",
  onchainContractAddress: CONTRACT,
  advertiserAddress: ADVERTISER,
  status: "active",
  rewardAtomic: "1000000",
  maxCompletions: 1,
  startAt: START,
  endAt: END,
} as CampaignRecord;
const submission = {
  id: "submission",
  campaignId: campaign.id,
  eligibilityId: "eligibility",
  claimantAddress: CLAIMANT,
  result: "accepted",
} as Awaited<ReturnType<SubmissionRepository["getById"]>>;
const eligibility = {
  id: "eligibility",
  campaignId: campaign.id,
  claimantAddress: CLAIMANT,
} as Awaited<ReturnType<EligibilityRepository["getById"]>>;

function fixture() {
  let current = NOW;
  let rpcSigner = signer.address;
  const chainState = {
    paidCompletions: 0,
    closedAt: 0,
    endTime: Math.floor(END.getTime() / 1000),
    claimed: false,
    rewardPerCompletion: 1_000_000,
  };
  let currentCampaign = campaign;
  /** What the contract's campaignIdByDraft says for this campaign's draft. */
  let canonicalId: number = 7;
  let halted = false;
  let currentSubmission = submission;
  let currentEligibility = eligibility;
  /** Indexed CampaignManager events for the campaign (what the indexer stored). */
  const indexedEvents: StoredEvent[] = [];
  const claims = new InMemoryClaimRepository(
    async () => currentSubmission,
    async () => currentCampaign,
  );
  const rpc = {
    call: async (_to: string, data: string) => {
      if (data.startsWith(toFunctionSelector("authorizedSigner()"))) {
        return `0x${"0".repeat(24)}${rpcSigner.slice(2)}`;
      }
      if (data.startsWith(FUNCTION_SELECTORS.campaigns)) {
        return encodeCampaignStruct({
          advertiser: ADVERTISER,
          fundedBudget: currentCampaign.maxCompletions * 1_000_000,
          paidRewards: chainState.paidCompletions * 1_000_000,
          rewardPerCompletion: chainState.rewardPerCompletion,
          maxCompletions: currentCampaign.maxCompletions,
          paidCompletions: chainState.paidCompletions,
          startTime: Math.floor(START.getTime() / 1000),
          endTime: chainState.endTime,
          closedAt: chainState.closedAt,
          status: chainState.closedAt === 0 ? 1 : 2,
        });
      }
      if (data.startsWith(FUNCTION_SELECTORS.campaignIdByDraft)) {
        const askedAdvertiser = `0x${data.slice(10 + 24, 10 + 64)}`;
        const askedRef = `0x${data.slice(10 + 64, 10 + 128)}`;
        return word(
          askedAdvertiser === currentCampaign.advertiserAddress &&
            askedRef === draftRefFor(currentCampaign.id)
            ? canonicalId
            : 0,
        );
      }
      if (
        data.startsWith(toFunctionSelector("claimedWallet(uint256,address)"))
      ) {
        return word(chainState.claimed ? 1 : 0);
      }
      throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
    },
  };

  const dependencies = {
    campaigns: {
      getById: async (id: string) =>
        currentCampaign.id === id ? currentCampaign : null,
    },
    submissions: {
      getById: async (id: string) =>
        currentSubmission?.id === id ? currentSubmission : null,
    },
    eligibility: {
      getById: async (id: string) =>
        currentEligibility?.id === id ? currentEligibility : null,
    },
    claims,
    signer,
    chain: {
      chainId: 84532,
      contractAddress: CONTRACT,
      rpc,
      events: { listCampaignEvents: async () => indexedEvents },
    },
    now: () => current,
    chainHalted: async () => halted,
  };
  const input = {
    campaignId: campaign.id,
    submissionId: "submission",
    eligibilityToken: "eligibility",
  };
  return {
    dependencies,
    input,
    setNow: (value: Date) => {
      current = value;
    },
    chainState,
    /** Records a RewardClaimed event for `nonce` as the indexer would. */
    indexClaim: (nonce: string, status: StoredEvent["status"]) => {
      indexedEvents.push({
        txHash: `0x${"77".repeat(32)}`,
        logIndex: indexedEvents.length,
        blockNumber: 100n,
        blockHash: `0x${"88".repeat(32)}`,
        status,
        event: {
          name: "RewardClaimed",
          campaignId: "7",
          claimant: CLAIMANT,
          amount: "1000000",
          nonce,
        },
      });
    },
    setRpcSigner: (value: typeof signer.address) => {
      rpcSigner = value;
    },
    setCampaign: (value: CampaignRecord) => {
      currentCampaign = value;
    },
    setCanonicalId: (value: number) => {
      canonicalId = value;
    },
    setHalted: (value: boolean) => {
      halted = value;
    },
    setSubmission: (value: typeof submission) => {
      currentSubmission = value;
    },
    setEligibility: (value: typeof eligibility) => {
      currentEligibility = value;
    },
  };
}

describe("EIP-712 claim authorization", () => {
  it("signs with the contract's MAX_AUTHORIZATION_TTL", () => {
    // Retention (privacy/retention.ts) and the issuance check
    // (claims/repository.ts) derive their windows from this one constant.
    const solidity = readFileSync(
      new URL(
        "../../../packages/contracts/src/CampaignManager.sol",
        import.meta.url,
      ),
      "utf8",
    );
    const declared =
      /uint64 public constant MAX_AUTHORIZATION_TTL = (\d+) (seconds|minutes|hours);/.exec(
        solidity,
      );
    expect(declared).not.toBeNull();
    const unit = { seconds: 1, minutes: 60, hours: 3600 }[
      declared![2] as "seconds" | "minutes" | "hours"
    ];
    expect(Number(declared![1]) * unit).toBe(MAX_CLAIM_TTL_SECONDS);
  });

  it("matches the contract type and binds every field and domain component", async () => {
    const typeString = `ClaimAuthorization(${CLAIM_TYPES.ClaimAuthorization.map(({ type, name }) => `${type} ${name}`).join(",")})`;
    expect(typeString).toBe(
      "ClaimAuthorization(uint256 campaignId,bytes32 draftRef,address claimant,uint256 amount,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)",
    );
    expect(keccak256(stringToHex(typeString))).toBe(
      "0x190486b79e77ff5517da40fe874a526fb3507c8999e73a8a70f90d4e2e90005b",
    );

    const signed = await signer.sign({
      campaignId: 7n,
      draftRef: draftRefFor("campaign"),
      claimant: CLAIMANT,
      amount: 1000000n,
      chainId: 84532,
      contractAddress: CONTRACT,
      issuedAt: 1791767400n,
    });
    const domain = {
      name: CLAIM_DOMAIN_NAME,
      version: CLAIM_DOMAIN_VERSION,
      chainId: signed.chainId,
      verifyingContract: signed.contractAddress,
    };
    const verify = (message: typeof signed.payload, changedDomain = domain) =>
      verifyTypedData({
        address: signer.address,
        domain: changedDomain,
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message,
        signature: signed.signature,
      });

    expect(signed.payload.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.payload.expiresAt - signed.payload.issuedAt).toBe(
      BigInt(MAX_CLAIM_TTL_SECONDS),
    );
    expect(await verify(signed.payload)).toBe(true);
    for (const changed of [
      { campaignId: 8n },
      { claimant: `0x${"44".repeat(20)}` as const },
      { amount: 1000001n },
      { nonce: `0x${"55".repeat(32)}` as const },
      { issuedAt: signed.payload.issuedAt + 1n },
      { expiresAt: signed.payload.expiresAt + 1n },
    ]) {
      expect(await verify({ ...signed.payload, ...changed })).toBe(false);
    }
    for (const changed of [
      { name: "Wrong name" },
      { version: "2" },
      { chainId: 1 },
      { verifyingContract: `0x${"66".repeat(20)}` as const },
    ]) {
      expect(await verify(signed.payload, { ...domain, ...changed })).toBe(
        false,
      );
    }
    expect(
      hashTypedData({
        domain,
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message: signed.payload,
      }),
    ).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("issues once for an accepted verified completion and replays the same signature", async () => {
    const f = fixture();
    const [first, retry] = await Promise.all([
      authorizeClaim(f.dependencies, f.input),
      authorizeClaim(f.dependencies, f.input),
    ]);
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.claim.signature).toBe(retry.claim.signature);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect(first.claim.payload.amount).toBe(1000000n);
    expect(first.claim.payload.campaignId).toBe(7n);
    f.setCampaign({ ...campaign, status: "closed" });
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: true,
      created: false,
    });
    // Expired and the campaign is closed: no fresh liability is created.
    f.setNow(new Date("2026-10-12T01:26:00.000Z"));
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_NOT_ACTIVE",
    });
  });

  it("signs nothing while a reorg beyond the confirmation depth is unrecovered", async () => {
    const f = fixture();
    const issued = await authorizeClaim(f.dependencies, f.input);
    expect(issued.ok).toBe(true);

    // Not even the replay of an authorization issued before the halt.
    f.setHalted(true);
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      status: 503,
      code: "CHAIN_HALTED",
    });
  });

  it("never signs for a link that is no longer this draft's canonical creation", async () => {
    const f = fixture();
    // A reorg removed this draft's creation and another draft's campaign now
    // holds on-chain id 7 (or this draft has none at all).
    for (const id of [8, 0]) {
      f.setCanonicalId(id);
      expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
        ok: false,
        code: "CAMPAIGN_NOT_ACTIVE",
      });
    }
  });

  it("never signs while the contract's campaign carries other economics than the draft", async () => {
    const f = fixture();
    const { claims } = f.dependencies;
    const draftReward = Number(campaign.rewardAtomic);
    let signCalls = 0;
    const counting = {
      ...f.dependencies,
      signer: {
        address: signer.address,
        sign: (request: Parameters<typeof signer.sign>[0]) => {
          signCalls += 1;
          return signer.sign(request);
        },
      },
    };
    f.chainState.rewardPerCompletion = 2 * draftReward;

    expect(await authorizeClaim(counting, f.input)).toMatchObject({
      ok: false,
      status: 409,
      code: "CAMPAIGN_NOT_ACTIVE",
    });
    expect(signCalls).toBe(0);
    expect(await claims.listIssuedClaims(campaign.id)).toEqual([]);

    f.chainState.rewardPerCompletion = draftReward;
    expect(await authorizeClaim(counting, f.input)).toMatchObject({
      ok: true,
      created: true,
    });
    expect(signCalls).toBe(1);
  });

  it("never signs for a campaign linked on another deployment (ADR-0011)", async () => {
    const f = fixture();
    // Same on-chain id 7, but on the CampaignManager used before a redeploy:
    // the current contract's campaign 7 is someone else's.
    f.setCampaign({
      ...campaign,
      onchainContractAddress: `0x${"99".repeat(20)}`,
    });

    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_NOT_ACTIVE",
    });
  });

  it("reissues an expired, unredeemed authorization with a new nonce", async () => {
    const f = fixture();
    const first = await authorizeClaim(f.dependencies, f.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    f.setNow(new Date("2026-10-12T01:26:00.000Z"));
    const reissued = await authorizeClaim(f.dependencies, f.input);

    expect(reissued).toMatchObject({ ok: true, created: true });
    if (!reissued.ok) return;
    expect(reissued.claim.payload.nonce).not.toBe(first.claim.payload.nonce);
    expect(reissued.claim.payload.issuedAt).toBe(
      BigInt(Math.floor(Date.parse("2026-10-12T01:26:00.000Z") / 1000)),
    );
  });

  it("answers 409 ALREADY_CLAIMED, never the stored authorization, once the wallet was paid (#82)", async () => {
    const f = fixture();
    const campaignId = "11111111-1111-4111-8111-111111111111";
    const submissionId = "22222222-2222-4222-8222-222222222222";
    const eligibilityToken = "33333333-3333-4333-8333-333333333333";
    f.setCampaign({ ...campaign, id: campaignId });
    f.setSubmission({
      ...submission!,
      id: submissionId,
      campaignId,
      eligibilityId: eligibilityToken,
    });
    f.setEligibility({ ...eligibility!, id: eligibilityToken, campaignId });
    let signCalls = 0;
    const app = Fastify();
    await registerClaimRoutes(app, {
      ...f.dependencies,
      signer: {
        address: signer.address,
        sign: (request: Parameters<typeof signer.sign>[0]) => {
          signCalls += 1;
          return signer.sign(request);
        },
      },
    });
    try {
      const request = () =>
        app.inject({
          method: "POST",
          url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
          payload: { eligibilityToken },
        });
      expect((await request()).statusCode).toBe(201);

      // The participant redeemed it. Before it expires a replay would be
      // reverted with NonceAlreadyUsed, after it a reissue with
      // WalletAlreadyClaimed: neither is returned.
      f.chainState.claimed = true;
      f.chainState.paidCompletions = 1;
      for (const at of [NOW, new Date("2026-10-12T01:26:00.000Z")]) {
        f.setNow(at);
        const again = await request();
        expect(again.statusCode).toBe(409);
        expect(again.json()).toMatchObject({
          error: { code: "ALREADY_CLAIMED", retryable: false },
        });
        expect(again.body).not.toContain("signature");
      }
      expect(signCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("answers ALREADY_CLAIMED once the stored nonce is a confirmed payout (#82)", async () => {
    const f = fixture();
    const first = await authorizeClaim(f.dependencies, f.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Observed only: it could still be reorged out, so the replay stands.
    f.indexClaim(first.claim.payload.nonce, "observed");
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: true,
      created: false,
    });

    f.indexClaim(first.claim.payload.nonce, "confirmed");
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      status: 409,
      code: "ALREADY_CLAIMED",
    });
  });

  it("caps paid plus outstanding authorizations at maxCompletions", async () => {
    const f = fixture();
    f.setCampaign({ ...campaign, maxCompletions: 2 });
    f.chainState.paidCompletions = 1;
    expect((await authorizeClaim(f.dependencies, f.input)).ok).toBe(true);

    // A second human while one is paid and one is outstanding: cap reached.
    f.setSubmission({ ...submission!, id: "submission-2" });
    const second = { ...f.input, submissionId: "submission-2" };
    expect(await authorizeClaim(f.dependencies, second)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_CAP_REACHED",
    });

    // The first authorization expires unredeemed and frees its slot.
    f.setNow(new Date("2026-10-12T01:26:00.000Z"));
    expect(await authorizeClaim(f.dependencies, second)).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it("frees a slot as soon as its authorization is confirmed paid on-chain", async () => {
    const f = fixture();
    f.setCampaign({ ...campaign, maxCompletions: 2 });
    const first = await authorizeClaim(f.dependencies, f.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The first human redeems at once: the contract now counts one paid
    // completion while the signature is still unexpired.
    f.chainState.paidCompletions = 1;
    f.setSubmission({ ...submission!, id: "submission-2" });
    const second = { ...f.input, submissionId: "submission-2" };

    // Not indexed yet: counted as paid and as outstanding (safe side).
    expect(await authorizeClaim(f.dependencies, second)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_CAP_REACHED",
    });

    // An observed (unconfirmed) payout could still be reorged out while the
    // signature stays redeemable, so it does not free the slot either.
    f.indexClaim(first.claim.payload.nonce, "observed");
    expect(await authorizeClaim(f.dependencies, second)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_CAP_REACHED",
    });

    // Confirmed: the payout is settled, the second human is served now
    // rather than after the 15 minute TTL.
    f.indexClaim(first.claim.payload.nonce.toUpperCase(), "confirmed");
    expect(await authorizeClaim(f.dependencies, second)).toMatchObject({
      ok: true,
      created: true,
    });

    // The cap itself still holds: paid 1 + outstanding 1 = maxCompletions.
    f.setSubmission({ ...submission!, id: "submission-3" });
    expect(
      await authorizeClaim(f.dependencies, {
        ...f.input,
        submissionId: "submission-3",
      }),
    ).toMatchObject({ ok: false, code: "CAMPAIGN_CAP_REACHED" });
  });

  it("reissues an authorization signed for a previous on-chain id after a deep reorg (ADR-0011)", async () => {
    const f = fixture();
    f.setCampaign({ ...campaign, maxCompletions: 1 });
    const first = await authorizeClaim(f.dependencies, f.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.claim.payload.campaignId).toBe(7n);

    // Recovery relinked the draft: its canonical creation now has id 9. The
    // stored signature names id 7 and can never be redeemed on the contract.
    f.setCampaign({ ...campaign, maxCompletions: 1, onchainCampaignId: "9" });
    f.setCanonicalId(9);

    // It is not outstanding liability either: another human gets the slot.
    f.setSubmission({ ...submission!, id: "submission-2" });
    const other = await authorizeClaim(f.dependencies, {
      ...f.input,
      submissionId: "submission-2",
    });
    expect(other).toMatchObject({ ok: true, created: true });
    if (!other.ok) return;
    expect(other.claim.payload.campaignId).toBe(9n);
    expect(other.claim.payload.nonce).not.toBe(first.claim.payload.nonce);

    // The first human's stale signature is never replayed: a new one would
    // be issued for id 9, but the cap is now full.
    f.setSubmission(submission);
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_CAP_REACHED",
    });
  });

  it("enforces the global 24 h payout limit (#23)", async () => {
    const f = fixture();
    f.setCampaign({ ...campaign, maxCompletions: 10 });
    const limited = { ...f.dependencies, dailyPayoutLimitAtomic: 1_500_000n };

    expect((await authorizeClaim(limited, f.input)).ok).toBe(true);
    // Replays of an existing authorization are not new liability.
    expect(await authorizeClaim(limited, f.input)).toMatchObject({
      ok: true,
      created: false,
    });

    f.setSubmission({ ...submission!, id: "submission-2" });
    const second = { ...f.input, submissionId: "submission-2" };
    expect(await authorizeClaim(limited, second)).toMatchObject({
      ok: false,
      status: 503,
      code: "DAILY_LIMIT_REACHED",
    });

    // 24 h later the window has moved on.
    f.setCampaign({
      ...campaign,
      maxCompletions: 10,
      endAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    f.chainState.endTime = Math.floor(
      Date.parse("2026-10-14T00:00:00Z") / 1000,
    );
    f.setNow(new Date("2026-10-13T01:10:01.000Z"));
    expect(await authorizeClaim(limited, second)).toMatchObject({ ok: true });
  });

  it("returns 503 SIGNER_UNAVAILABLE when the signing service fails", async () => {
    const f = fixture();
    const failing = {
      ...f.dependencies,
      signer: {
        address: signer.address,
        sign: async () => {
          throw new SignerUnavailableError("KMS timeout");
        },
      },
    };

    expect(await authorizeClaim(failing, f.input)).toMatchObject({
      ok: false,
      status: 503,
      code: "SIGNER_UNAVAILABLE",
    });
  });

  it("stops issuing as soon as the campaign is closed on-chain", async () => {
    const f = fixture();
    f.chainState.closedAt = Math.floor(NOW.getTime() / 1000) - 5;

    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_NOT_ACTIVE",
    });
  });

  it("fails closed for rejected or unverified submissions and wrong signer", async () => {
    const f = fixture();
    f.setSubmission({ ...submission!, result: "rejected" });
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "SUBMISSION_NOT_ACCEPTED",
    });
    f.setSubmission(submission);
    f.setEligibility(null);
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "INVALID_ELIGIBILITY",
    });
    f.setEligibility(eligibility);
    f.setRpcSigner(`0x${"44".repeat(20)}`);
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "SIGNER_MISMATCH",
    });
    f.setRpcSigner(signer.address);
    f.setCampaign({ ...campaign, status: "closed" });
    expect(await authorizeClaim(f.dependencies, f.input)).toMatchObject({
      ok: false,
      code: "CAMPAIGN_NOT_ACTIVE",
    });
  });

  it("returns one authorization from the HTTP endpoint on retries", async () => {
    const f = fixture();
    const campaignId = "11111111-1111-4111-8111-111111111111";
    const submissionId = "22222222-2222-4222-8222-222222222222";
    const eligibilityToken = "33333333-3333-4333-8333-333333333333";
    f.setCampaign({ ...campaign, id: campaignId });
    f.setSubmission({
      ...submission!,
      id: submissionId,
      campaignId,
      eligibilityId: eligibilityToken,
    });
    f.setEligibility({ ...eligibility!, id: eligibilityToken, campaignId });

    const app = Fastify();
    await registerClaimRoutes(app, f.dependencies);
    try {
      const request = () =>
        app.inject({
          method: "POST",
          url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
          payload: { eligibilityToken },
        });
      const first = await request();
      const second = await request();
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({
        campaignId: "7",
        claimant: CLAIMANT,
        amount: "1000000",
        chainId: 84532,
        contractAddress: CONTRACT,
      });
      const denied = await app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
        payload: { eligibilityToken: "44444444-4444-4444-8444-444444444444" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
