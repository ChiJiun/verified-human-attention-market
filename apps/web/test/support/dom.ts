import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  encodeErrorResult,
  type ContractErrorName,
  type EIP1193Provider,
} from "viem";
import { vi } from "vitest";

/**
 * Helpers for the page tests (*.dom.test.tsx): an injected wallet for
 * window.ethereum and a fetch for the API. The pages build their viem
 * clients on the wallet (lib/wallet.ts), so its answers are the node's, as
 * in claim.test.ts.
 */

type RpcHandler = (params: readonly unknown[]) => unknown;

/** An EIP-1193 wallet answering from `handlers`; records each method asked. */
export function injectedWallet(handlers: Record<string, RpcHandler>) {
  const methods: string[] = [];
  const provider = {
    async request({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[];
    }) {
      methods.push(method);
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params ?? []);
    },
    on() {},
    removeListener() {},
  };
  return {
    provider: provider as unknown as EIP1193Provider,
    methods,
    count: (method: string) =>
      methods.filter((asked) => asked === method).length,
  };
}

/** What a node answers for an eth_call that reverts with `errorName`. */
export function revert(
  errorName: ContractErrorName<typeof campaignManagerAbi>,
): Error {
  return Object.assign(new Error("execution reverted"), {
    code: 3,
    data: encodeErrorResult({ abi: campaignManagerAbi, errorName }),
  });
}

export interface ApiAnswer {
  status?: number;
  body?: unknown;
}

/**
 * A fetch for the API behind /api: `routes` maps "METHOD /v1/..." to an
 * answer. Any other request throws, which the pages show as an error.
 */
export function apiFetch(routes: Record<string, () => ApiAnswer>) {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const route = `${init?.method ?? "GET"} ${pathname.replace(/^\/api/, "")}`;
    requests.push(route);
    const answer = routes[route];
    if (!answer) throw new Error(`unexpected request ${route}`);
    const { status = 200, body = {} } = answer();
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch, requests };
}
