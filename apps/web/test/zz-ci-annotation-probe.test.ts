import { describe, expect, it } from "vitest";

// Temporary probe for PR #112: proves on a real runner that each failed
// test becomes one annotation. Reverted in the next commit.
describe("CI annotation probe (web)", () => {
  it("fails on purpose: first", () => {
    expect(1).toBe(2);
  });

  it("fails on purpose: second", () => {
    expect("web").toBe("not web");
  });
});
