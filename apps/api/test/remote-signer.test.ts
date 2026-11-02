import { describe, expect, it } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_TYPES,
  createClaimSigner,
  createRemoteClaimSigner,
  SignerUnavailableError,
} from "../src/claims/signer.js";

const kmsKey = privateKeyToAccount(`0x${"4b".repeat(32)}`);
const otherKey = privateKeyToAccount(`0x${"5c".repeat(32)}`);
const CONTRACT = `0x${"22".repeat(20)}` as const;
const input = {
  campaignId: 7n,
  draftRef: `0x${"d1".repeat(32)}` as const,
  claimant: `0x${"33".repeat(20)}` as const,
  amount: 1_000_000n,
  chainId: 84532,
  contractAddress: CONTRACT,
  issuedAt: 1_791_800_000n,
};

interface TypedDataRequest {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  message: Record<string, string>;
}

/**
 * Stand-in for a Web3Signer-style service whose key lives in a KMS. It
 * signs with `signingKey`, which lets tests simulate a misconfigured
 * service holding a different key.
 */
function fakeSigningService(
  options: {
    signingKey?: typeof kmsKey;
    accounts?: string[];
    status?: number;
    tamper?: (request: TypedDataRequest) => TypedDataRequest;
  } = {},
) {
  const calls: { method: string; params: unknown[]; auth: string | null }[] =
    [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const headers = init.headers as Record<string, string>;
    calls.push({
      method: body.method,
      params: body.params,
      auth: headers.authorization ?? null,
    });

    if (options.status) {
      return new Response("unavailable", { status: options.status });
    }

    if (body.method === "eth_accounts") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: options.accounts ?? [kmsKey.address.toLowerCase()],
      });
    }

    const typedData = (options.tamper ?? ((value) => value))(
      body.params[1] as TypedDataRequest,
    );
    const { EIP712Domain, ...types } = typedData.types;
    expect(EIP712Domain).toHaveLength(4);
    const signature = await (options.signingKey ?? kmsKey).signTypedData({
      domain: typedData.domain,
      types: types as unknown as typeof CLAIM_TYPES,
      primaryType: "ClaimAuthorization",
      message: {
        campaignId: BigInt(typedData.message.campaignId!),
        draftRef: typedData.message.draftRef as Hex,
        claimant: typedData.message.claimant as Hex,
        amount: BigInt(typedData.message.amount!),
        nonce: typedData.message.nonce as Hex,
        issuedAt: BigInt(typedData.message.issuedAt!),
        expiresAt: BigInt(typedData.message.expiresAt!),
      },
    });

    return Response.json({ jsonrpc: "2.0", id: body.id, result: signature });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function remote(service: ReturnType<typeof fakeSigningService>) {
  return createRemoteClaimSigner({
    url: "https://signer.internal.example/",
    address: kmsKey.address,
    authorization: "Bearer signer-token",
    fetch: service.fetchImpl,
  });
}

describe("remote (KMS-backed) claim signer", () => {
  it("produces the same verifiable EIP-712 authorization as a local key", async () => {
    const service = fakeSigningService();
    const signer = remote(service);

    await expect(signer.checkAvailable()).resolves.toBeUndefined();
    const claim = await signer.sign(input);

    expect(
      await verifyTypedData({
        address: kmsKey.address,
        domain: {
          name: CLAIM_DOMAIN_NAME,
          version: CLAIM_DOMAIN_VERSION,
          chainId: 84532,
          verifyingContract: CONTRACT,
        },
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message: claim.payload,
        signature: claim.signature,
      }),
    ).toBe(true);
    expect(claim.payload.expiresAt - claim.payload.issuedAt).toBe(900n);
    expect(service.calls.map((call) => call.method)).toEqual([
      "eth_accounts",
      "eth_signTypedData",
    ]);
    expect(service.calls[1]!.params[0]).toBe(kmsKey.address);
    expect(service.calls[1]!.auth).toBe("Bearer signer-token");

    // A local signer with the same key has the same address.
    const local = createClaimSigner(`0x${"4b".repeat(32)}`);
    expect(local.address).toBe(signer.address);
  });

  it("rejects a service that does not hold the configured key", async () => {
    const signer = remote(
      fakeSigningService({ accounts: [otherKey.address.toLowerCase()] }),
    );

    await expect(signer.checkAvailable()).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("rejects signatures from another key", async () => {
    const signer = remote(fakeSigningService({ signingKey: otherKey }));

    await expect(signer.sign(input)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("rejects a signature over a different payload", async () => {
    const signer = remote(
      fakeSigningService({
        tamper: (request) => ({
          ...request,
          message: { ...request.message, amount: "999000000" },
        }),
      }),
    );

    await expect(signer.sign(input)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("fails closed on HTTP errors and unreachable services", async () => {
    await expect(
      remote(fakeSigningService({ status: 500 })).sign(input),
    ).rejects.toBeInstanceOf(SignerUnavailableError);

    const unreachable = createRemoteClaimSigner({
      url: "https://signer.internal.example/",
      address: kmsKey.address,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(unreachable.sign(input)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("validates its configuration", () => {
    expect(() =>
      createRemoteClaimSigner({ url: "ftp://x", address: kmsKey.address }),
    ).toThrow();
    expect(() =>
      createRemoteClaimSigner({ url: "https://x.example", address: "0x12" }),
    ).toThrow();
  });
});
