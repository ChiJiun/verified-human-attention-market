import { describe, expect, it } from "vitest";

import { isCurrentDeployment } from "../src/deployment.js";

const CURRENT = {
  chainId: 84532,
  contractAddress: "0xAbCdEf0000000000000000000000000000000001",
};

describe("isCurrentDeployment (ADR-0011)", () => {
  it("accepts a link on the same chain and contract, ignoring address case", () => {
    expect(
      isCurrentDeployment(
        {
          chainId: 84532,
          contractAddress: "0xabcdef0000000000000000000000000000000001",
        },
        CURRENT,
      ),
    ).toBe(true);
  });

  it("rejects the same address on another chain", () => {
    expect(
      isCurrentDeployment(
        { chainId: 31337, contractAddress: CURRENT.contractAddress },
        CURRENT,
      ),
    ).toBe(false);
  });

  it("rejects another contract on the same chain", () => {
    expect(
      isCurrentDeployment(
        {
          chainId: 84532,
          contractAddress: "0x12cc9447ceb3f8e75ddf4463a1a4d9feb42bdfec",
        },
        CURRENT,
      ),
    ).toBe(false);
  });

  it("rejects unlinked campaigns, pre-ADR-0011 links and a missing configuration", () => {
    expect(
      isCurrentDeployment({ chainId: 84532, contractAddress: null }, CURRENT),
    ).toBe(false);
    expect(
      isCurrentDeployment(
        { chainId: 84532, contractAddress: "pre-adr-0011" },
        CURRENT,
      ),
    ).toBe(false);
    expect(
      isCurrentDeployment(
        { chainId: 84532, contractAddress: CURRENT.contractAddress },
        null,
      ),
    ).toBe(false);
  });
});
