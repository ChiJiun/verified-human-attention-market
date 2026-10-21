import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  newWorldIdSignalSalt,
  worldIdSignal,
  type WorldIdSignal,
} from "@vham/shared/world-id";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";

import { signalHash } from "../src/identity/world-id.js";

const root = new URL("../../../", import.meta.url);
const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

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

  it("equals the installed IDKit hashSignal on random salted signals", () => {
    for (let index = 0; index < 500; index += 1) {
      const signal = worldIdSignal({
        campaignId: randomUUID(),
        claimant: bytesToHex(crypto.getRandomValues(new Uint8Array(20))),
        salt: newWorldIdSignalSalt(),
      });

      expect(signalHash(signal)).toBe(hashSignal(signal));
    }
  });

  it("is checked against the idkit-core version the web's IDKit resolves", () => {
    const webIdkit = readJson("apps/web/package.json").dependencies?.[
      "@worldcoin/idkit"
    ];
    const pinned = readJson("apps/api/package.json").devDependencies?.[
      "@worldcoin/idkit-core"
    ];
    const installed = readJson(
      "apps/api/node_modules/@worldcoin/idkit-core/package.json",
    ).version;
    const blocks = readFileSync(new URL("pnpm-lock.yaml", root), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n\n");
    const snapshot = blocks.find((block) =>
      block.startsWith(`  '@worldcoin/idkit@${webIdkit}(`),
    );
    const resolved = snapshot?.match(/'@worldcoin\/idkit-core': (\S+)/)?.[1];

    expect(webIdkit).toBe("4.4.0");
    expect(resolved).toBe(pinned);
    expect(installed).toBe(pinned);
  });
});
