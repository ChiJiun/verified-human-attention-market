import { randomBytes } from "node:crypto";

import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CLAIM_TYPES = {
  ClaimAuthorization: [
    { name: "campaignId", type: "uint256" },
    { name: "claimant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const CLAIM_DOMAIN_NAME = "Verified Human Attention Market";
export const CLAIM_DOMAIN_VERSION = "1";
export const MAX_CLAIM_TTL_SECONDS = 900;

export interface ClaimPayload {
  campaignId: bigint;
  claimant: Address;
  amount: bigint;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface SignedClaim {
  payload: ClaimPayload;
  signature: Hex;
  chainId: number;
  contractAddress: Address;
}

export interface ClaimSigner {
  readonly address: Address;
  sign(input: {
    campaignId: bigint;
    claimant: Address;
    amount: bigint;
    chainId: number;
    contractAddress: Address;
    issuedAt: bigint;
  }): Promise<SignedClaim>;
}

/** Signing failed or was unverifiable; no authorization is issued. */
export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

function newPayload(input: {
  campaignId: bigint;
  claimant: Address;
  amount: bigint;
  issuedAt: bigint;
}): ClaimPayload {
  return {
    campaignId: input.campaignId,
    claimant: input.claimant,
    amount: input.amount,
    nonce: `0x${randomBytes(32).toString("hex")}`,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + BigInt(MAX_CLAIM_TTL_SECONDS),
  };
}

function claimDomain(chainId: number, contractAddress: Address) {
  return {
    name: CLAIM_DOMAIN_NAME,
    version: CLAIM_DOMAIN_VERSION,
    chainId,
    verifyingContract: contractAddress,
  };
}

/**
 * Local key signer: development and testnets only. The key stays in the
 * server process and is never included in errors. Production uses
 * {@link createRemoteClaimSigner} so the key never enters the API (#23).
 */
export function createClaimSigner(privateKey: string): ClaimSigner {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("CLAIM_SIGNER_PRIVATE_KEY must be a 32-byte hex key");
  }

  const account = privateKeyToAccount(privateKey as Hex);

  return {
    address: account.address,
    async sign(input) {
      const payload = newPayload(input);
      const signature = await account.signTypedData({
        domain: claimDomain(input.chainId, input.contractAddress),
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message: payload,
      });

      return {
        payload,
        signature,
        chainId: input.chainId,
        contractAddress: input.contractAddress,
      };
    },
  };
}

export interface RemoteClaimSignerOptions {
  /** JSON-RPC endpoint of the signing service (e.g. Web3Signer eth1 mode). */
  url: string;
  /** Address of the KMS/HSM-held key; must equal the contract's signer. */
  address: string;
  /** Optional `Authorization` header value for the signing service. */
  authorization?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Remote signer (#23): the key lives in a KMS/HSM behind a signing service
 * that speaks `eth_signTypedData` (Web3Signer's eth1 JSON-RPC, checked
 * 2026-10-13: https://docs.web3signer.consensys.com/reference/api/json-rpc).
 * Every returned signature is recovered locally and must come from
 * `address` for this exact payload, so a misbehaving service cannot make
 * the API hand out an authorization it did not intend.
 */
export function createRemoteClaimSigner(
  options: RemoteClaimSignerOptions,
): ClaimSigner & { checkAvailable(): Promise<void> } {
  if (!/^https?:\/\//.test(options.url)) {
    throw new Error("CLAIM_SIGNER_URL must be an http(s) URL");
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(options.address)) {
    throw new Error("CLAIM_SIGNER_ADDRESS must be a 20-byte hex address");
  }

  const address = getAddress(options.address);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let requestId = 0;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.authorization
            ? { authorization: options.authorization }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          params,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SignerUnavailableError(
        `${method}: signing service unreachable`,
      );
    }

    if (!response.ok) {
      throw new SignerUnavailableError(`${method}: HTTP ${response.status}`);
    }

    const body = (await response.json().catch(() => null)) as {
      result?: unknown;
      error?: unknown;
    } | null;

    if (!body || body.error !== undefined || body.result === undefined) {
      throw new SignerUnavailableError(`${method}: signing service error`);
    }

    return body.result;
  }

  return {
    address,
    async checkAvailable() {
      const accounts = await rpc("eth_accounts", []);
      if (
        !Array.isArray(accounts) ||
        !accounts.some(
          (account) =>
            typeof account === "string" &&
            account.toLowerCase() === address.toLowerCase(),
        )
      ) {
        throw new SignerUnavailableError(
          "Signing service does not hold CLAIM_SIGNER_ADDRESS",
        );
      }
    },
    async sign(input) {
      const payload = newPayload(input);
      const domain = claimDomain(input.chainId, input.contractAddress);
      const typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...CLAIM_TYPES,
        },
        primaryType: "ClaimAuthorization",
        domain,
        message: {
          campaignId: payload.campaignId.toString(),
          claimant: payload.claimant,
          amount: payload.amount.toString(),
          nonce: payload.nonce,
          issuedAt: payload.issuedAt.toString(),
          expiresAt: payload.expiresAt.toString(),
        },
      };
      const signature = await rpc("eth_signTypedData", [address, typedData]);

      if (
        typeof signature !== "string" ||
        !/^0x[0-9a-fA-F]{130}$/.test(signature)
      ) {
        throw new SignerUnavailableError("Malformed signature from signer");
      }

      const recovered = await recoverTypedDataAddress({
        domain,
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message: payload,
        signature: signature as Hex,
      }).catch(() => null);

      if (recovered?.toLowerCase() !== address.toLowerCase()) {
        throw new SignerUnavailableError(
          "Signing service returned a signature for another key or payload",
        );
      }

      return {
        payload,
        signature: signature as Hex,
        chainId: input.chainId,
        contractAddress: input.contractAddress,
      };
    },
  };
}
