import type { WorldIdSignal } from "@vham/shared/world-id";
import { describe, expect, it } from "vitest";

import { signalHash } from "../src/identity/world-id-signal.js";

describe("signalHash", () => {
  it("matches @worldcoin/idkit-core 4.4.0 hashSignal for a 0x hex signal", () => {
    expect(signalHash(`0x${"11".repeat(32)}` as WorldIdSignal)).toBe(
      "0x00b569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf8",
    );
    expect(
      signalHash(
        "0x4121a22cb3c4235896c8d56447fc0a52261a53d0b9615c14339c94ebb92da669" as WorldIdSignal,
      ),
    ).toBe(
      "0x0035dc5da2e0cd5b9b9bc2f33db299cf1212a12f3e6c3b54767c268051cfc01a",
    );
  });
});
