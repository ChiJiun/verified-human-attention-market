import { describe, expect, it } from "vitest";

import { EVENT_TOPICS } from "../src/chain/abi.js";
import {
  bloomContains,
  bloomMatcher,
  logsBloom,
  parseBloom,
} from "../src/chain/bloom.js";

/**
 * Real Base Sepolia (84532) headers and every log of their blocks, read
 * from https://sepolia.base.org on 2026-11-03 with eth_getBlockByNumber and
 * eth_getLogs({ blockHash }) (issue #102).
 */
const SPARSE_BLOCKS = [
  {
    number: 53_597_799,
    hash: "0xf69de08c987e7cafc9602760d9ba63b4854d7268f5f11f0098e12d123a7c29f9",
    logsBloom:
      "0x00000000040000000000000000000000000000000000000000000000000000000000000000001004000000000000000000000000002000000000000200000000000000000000000000000008000000000000000800000200000009000002000800008000090000000000040000000000000000000000000000000010000000000000000000000000000000000000000000000000000000004000000000000000000200000100000000000000040000000004000000000000000000000000000000000402001000000000000000000000000000000000000000000000000000000000000000000000000010000020000000000000000000000000000000000000",
    logs: [
      {
        address: "0xe09e8c03b8982bcebbbc96ef63a281e746040f5f",
        topics: [
          "0xbcd10d64fce9dcf9568572ed92e371df336d32649e8960a045c9548794a44b26",
          "0xfd121bde813a3463e16ad2a4ea4103a6a122fbe2cdb07a80d4d293be07bb29fa",
        ],
      },
      // Circle's Base Sepolia USDC, the POC's reward token.
      {
        address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        topics: [
          "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
          "0x000000000000000000000000a849bbad82f9edafdf9a5550cc874276138779d9",
          "0x892b1aa1e117c27ef82ad951d28039d483a789509da434dffe965a5d97982a87",
        ],
      },
      {
        address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000a849bbad82f9edafdf9a5550cc874276138779d9",
          "0x0000000000000000000000002824377bea69aa4789d9fe5fe062a1187d45b9fb",
        ],
      },
    ],
  },
  {
    number: 53_597_807,
    hash: "0x836c98c9eeeb163e20c120f48485f32d254237da681c05f835d23b9bb3f52171",
    logsBloom:
      "0x00000003000000000000000000000000000000000000000000000000000000000000080100001200000000000000000000400000000000000000000000000000000000000002000000800008000000000000000000001000000008000000000000008000080000000000040000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000080000000000000000000000000000000002000002000002000000000000020000002000000000000000000000000000000001000001000000000000000000000000000000000000000000000000000080000000",
    logs: [
      {
        address: "0xe09e8c03b8982bcebbbc96ef63a281e746040f5f",
        topics: [
          "0xbcd10d64fce9dcf9568572ed92e371df336d32649e8960a045c9548794a44b26",
          "0xf4940d379cdb765b9e0430725c0c9efb14a767ce50a687ac4658cce705407380",
        ],
      },
      {
        address: "0x7f1befe0bc46037832aef6a94f90e9a1b929276f",
        topics: [
          "0x27330bd7589580547b6437e08f9c60653de63691d2d2b2c13bff9ee67da2a68d",
          "0x0000000000000000000000007d230769f9fc12fa6ef62e7911e028f9440d8c0b",
        ],
      },
      {
        address: "0xaa0fc38dfddd29c0335dd546e6e5e80cffd86dbe",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x0000000000000000000000007d230769f9fc12fa6ef62e7911e028f9440d8c0b",
          "0x0000000000000000000000007f1befe0bc46037832aef6a94f90e9a1b929276f",
        ],
      },
    ],
  },
];

/**
 * Block 48106357, which deployed the 2026-10-14 CampaignManager
 * (packages/contracts/deployments/archive): 106 transactions and 258 logs,
 * two of them the contract's constructor events.
 */
const DEPLOY_BLOCK = {
  logsBloom:
    "0x04010010942900424526088220100006008550001800210028800813104080c0200a880240088180c0000090100101290300002202a02090c220000a49a16208821253000030204e0499203c084022010821240000002200404200001250004c68920000031645503500108125009980002c3002a000830802000010040d406080700213100820044400000000c402108105280815380101486808002000002202a010410101e0004090130088010111088420dc008c40023d2409201200420000008212595b06402041200888a01010001009c18c088010700a001018002394025280040000a043848263414a230a8412240011a8908008ac4808b22a6ca218",
  campaignManager: "0x12cc9447ceb3f8e75ddf4463a1a4d9feb42bdfec",
  ownershipTransferred:
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  signerUpdated:
    "0x2d025324f0a785e8c12d0a0d91a9caa49df4ef20ff87e0df7213a1d4f3157beb",
};

const EVENT_TOPIC_LIST = Object.values(EVENT_TOPICS);

describe("logs bloom (issue #102)", () => {
  it.each(SPARSE_BLOCKS)(
    "computes block $number's header bloom from its logs",
    (block) => {
      expect(logsBloom(block.logs)).toBe(block.logsBloom);
    },
  );

  it.each(SPARSE_BLOCKS)(
    "finds every address and topic of block $number in its header bloom",
    (block) => {
      const bloom = parseBloom(block.logsBloom)!;

      for (const log of block.logs) {
        expect(bloomContains(bloom, log.address)).toBe(true);
        for (const topic of log.topics) {
          expect(bloomContains(bloom, topic)).toBe(true);
        }
      }
      // Values of no log there: the bloom rules them out.
      expect(bloomContains(bloom, DEPLOY_BLOCK.campaignManager)).toBe(false);
      expect(bloomContains(bloom, block.hash)).toBe(false);
      expect(
        bloomMatcher(DEPLOY_BLOCK.campaignManager, EVENT_TOPIC_LIST)(bloom),
      ).toBe(false);
    },
  );

  it("flags the real CampaignManager deployment block among 258 logs", () => {
    const bloom = parseBloom(DEPLOY_BLOCK.logsBloom)!;

    expect(EVENT_TOPICS.OwnershipTransferred).toBe(
      DEPLOY_BLOCK.ownershipTransferred,
    );
    expect(EVENT_TOPICS.SignerUpdated).toBe(DEPLOY_BLOCK.signerUpdated);
    expect(bloomContains(bloom, DEPLOY_BLOCK.campaignManager)).toBe(true);
    expect(bloomContains(bloom, DEPLOY_BLOCK.ownershipTransferred)).toBe(true);
    expect(bloomContains(bloom, DEPLOY_BLOCK.signerUpdated)).toBe(true);
    expect(
      bloomMatcher(DEPLOY_BLOCK.campaignManager, EVENT_TOPIC_LIST)(bloom),
    ).toBe(true);
    // Checksummed input is the same value.
    expect(
      bloomContains(bloom, "0x12cc9447CEb3f8E75dDf4463A1A4D9feB42bDFEc"),
    ).toBe(true);
  });

  it("needs the address and one of the topics together", () => {
    const contract = DEPLOY_BLOCK.campaignManager;
    const other = "0x" + "e".repeat(40);
    const matches = bloomMatcher(contract, EVENT_TOPIC_LIST);
    const bloomOf = (logs: { address: string; topics: string[] }[]) =>
      parseBloom(logsBloom(logs))!;

    expect(
      matches(
        bloomOf([{ address: contract, topics: [EVENT_TOPICS.CampaignFunded] }]),
      ),
    ).toBe(true);
    expect(matches(bloomOf([]))).toBe(false);
    expect(
      matches(
        bloomOf([{ address: contract, topics: ["0x" + "1".repeat(64)] }]),
      ),
    ).toBe(false);
    expect(
      matches(
        bloomOf([{ address: other, topics: [EVENT_TOPICS.CampaignFunded] }]),
      ),
    ).toBe(false);
    // Both present, from different logs: the false positive a re-read
    // by block hash must settle.
    expect(
      matches(
        bloomOf([
          { address: contract, topics: ["0x" + "1".repeat(64)] },
          { address: other, topics: [EVENT_TOPICS.CampaignFunded] },
        ]),
      ),
    ).toBe(true);
  });

  it("accepts only a 256-byte hex bloom", () => {
    expect(parseBloom(`0x${"0".repeat(512)}`)).toEqual(new Uint8Array(256));
    expect(
      parseBloom(`0x${"F".repeat(512)}`)?.every((byte) => byte === 255),
    ).toBe(true);
    for (const invalid of [
      "",
      "0x",
      `0x${"0".repeat(510)}`,
      `0x${"g".repeat(512)}`,
    ]) {
      expect(parseBloom(invalid)).toBeNull();
    }
    expect(logsBloom([])).toBe(`0x${"0".repeat(512)}`);
  });
});
