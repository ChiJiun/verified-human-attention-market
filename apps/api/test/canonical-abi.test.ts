import { campaignManagerAbi } from "@vham/shared/contracts";
import { describe, expect, it } from "vitest";
import { parseAbi, toEventSelector, toFunctionSelector } from "viem";

import { EVENT_TOPICS, FUNCTION_SELECTORS } from "../src/chain/abi.js";

/**
 * The API decodes logs and builds calls from hand-written fragments. This
 * pins every one of them to the canonical ABI generated from `forge build`
 * (packages/shared, issue #19), so web, API and contract cannot diverge.
 */
describe("API contract fragments match the canonical ABI", () => {
  const signature = (entry: {
    name: string;
    inputs: readonly {
      type: string;
      components?: readonly { type: string }[];
    }[];
  }) =>
    `${entry.name}(${entry.inputs
      .map((input) =>
        input.type === "tuple"
          ? `(${(input.components ?? []).map((component) => component.type).join(",")})`
          : input.type,
      )
      .join(",")})`;

  it("event topics", () => {
    for (const [name, topic] of Object.entries(EVENT_TOPICS)) {
      const event = campaignManagerAbi.find(
        (entry) => entry.type === "event" && entry.name === name,
      );
      expect(event, name).toBeDefined();
      expect(toEventSelector(signature(event as never))).toBe(topic);
    }
  });

  it("function selectors", () => {
    for (const [name, selector] of Object.entries(FUNCTION_SELECTORS)) {
      const fn = campaignManagerAbi.find(
        (entry) => entry.type === "function" && entry.name === name,
      );
      expect(fn, name).toBeDefined();
      expect(toFunctionSelector(signature(fn as never))).toBe(selector);
    }
  });

  it("claim-service fragments", () => {
    const fragments = parseAbi([
      "function claimedWallet(uint256 campaignId, address claimant) view returns (bool)",
      "function authorizedSigner() view returns (address)",
    ]);

    for (const fragment of fragments) {
      const canonical = campaignManagerAbi.find(
        (entry) => entry.type === "function" && entry.name === fragment.name,
      );
      expect(canonical, fragment.name).toBeDefined();
      expect(toFunctionSelector(signature(canonical as never))).toBe(
        toFunctionSelector(signature(fragment as never)),
      );
      expect(
        (canonical as unknown as { outputs: { type: string }[] }).outputs.map(
          (output) => output.type,
        ),
      ).toEqual(fragment.outputs.map((output) => output.type));
    }
  });
});
