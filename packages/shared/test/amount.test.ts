import { describe, expect, it } from "vitest";

import { atomicAmountSchema } from "../src/index.js";

describe("atomicAmountSchema", () => {
  it("accepts integer strings", () => {
    expect(atomicAmountSchema.parse("1000000")).toBe("1000000");
  });

  it("rejects floating point values", () => {
    expect(() => atomicAmountSchema.parse("1.5")).toThrow();
  });
});
