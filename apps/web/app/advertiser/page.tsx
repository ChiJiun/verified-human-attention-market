"use client";

import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  prepareBroadcast,
  resolveCreateBroadcast,
  type BroadcastIntent,
} from "@vham/shared/recovery";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseAbi, type Address, type Hash } from "viem";

import { api, describeError } from "../../lib/api";
import { chain, chainId, USDC_DECIMALS } from "../../lib/config";
import { signInWithEthereum, type Session } from "../../lib/siwe";
import { connectWallet, waitForTx, type Wallet } from "../../lib/wallet";
import { CampaignForm, type CampaignPayload } from "./CampaignForm";

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

interface PublishIntent {
  campaignManager: Address;
  steps: {
    contract: Address;
    function: string;
    args: Record<string, string | number>;
  }[];
}

interface Analytics {
  campaignId: string;
  onchainCampaignId: string | null;
  status: string;
  plannedBudget: string;
  submissions: {
    accepted: number;
    rejected: number;
    flaggedAccepted: number;
    adjustedAccepted: number;
    flagReasons: Record<string, number>;
  };
  settlement: {
    confirmed: {
      funded: string;
      paidRewards: string;
      remaining: string;
      paidCompletions: number;
    };
    pending: { funded: string };
    hasUnconfirmedEvents: boolean;
  } | null;
}

type TxStatus =
  | { state: "idle" }
  | { state: "signing"; label: string }
  | { state: "pending"; label: string; hash: Hash }
  | { state: "reconciling"; label: string; hash: Hash }
  | { state: "done"; label: string; hash: Hash }
  | { state: "failed"; label: string; message: string };

const usdc = (atomic: string) =>
  `${formatUnits(BigInt(atomic), USDC_DECIMALS)} USDC`;

/** Survives a page reload so a broadcast transaction is never sent twice. */
const pendingKey = (campaignId: string) => `vham:create-tx:${campaignId}`;
function rememberTx(campaignId: string, hash: Hash | null) {
  try {
    if (hash) localStorage.setItem(pendingKey(campaignId), hash);
    else localStorage.removeItem(pendingKey(campaignId));
  } catch {
    // Storage may be unavailable (private mode); the flow still works.
  }
}
function recallTx(campaignId: string): Hash | null {
  try {
    return localStorage.getItem(pendingKey(campaignId)) as Hash | null;
  } catch {
    return null;
  }
}

/**
 * Recorded before the create transaction is sent. If the wallet or RPC fails
 * after broadcasting, there is no hash; the intent lets the next attempt find
 * the transaction instead of creating a second campaign (#13).
 */
const intentKey = (campaignId: string) => `vham:create-intent:${campaignId}`;
function rememberIntent(campaignId: string, intent: BroadcastIntent | null) {
  try {
    if (intent)
      localStorage.setItem(intentKey(campaignId), JSON.stringify(intent));
    else localStorage.removeItem(intentKey(campaignId));
  } catch {
    // Storage unavailable: recovery then relies on the indexer auto-link.
  }
}
function recallIntent(campaignId: string): BroadcastIntent | null {
  try {
    const raw = localStorage.getItem(intentKey(campaignId));
    return raw ? (JSON.parse(raw) as BroadcastIntent) : null;
  } catch {
    return null;
  }
}

export default function AdvertiserPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tx, setTx] = useState<TxStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const wrongNetwork = wallet !== null && wallet.chainId !== chainId;

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("campaign");
    if (id) setCampaignId(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!campaignId || !session) return;
    try {
      const { data } = await api<Analytics>(
        `/v1/campaigns/${campaignId}/analytics`,
        { token: session.token },
      );
      setAnalytics(data);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [campaignId, session]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run(async () => {
      setWallet(await connectWallet());
      setSession(null);
    });

  const switchNetwork = () =>
    run(async () => {
      if (!wallet) return;
      await wallet.walletClient.switchChain({ id: chainId });
      setWallet({ ...wallet, chainId: await wallet.walletClient.getChainId() });
    });

  const signIn = () =>
    run(async () => {
      if (!wallet) return;
      setSession(await signInWithEthereum(wallet.walletClient, wallet.address));
    });

  const createDraft = (payload: CampaignPayload) =>
    run(async () => {
      if (!session) return;
      const { data } = await api<{ id: string }>("/v1/campaigns", {
        method: "POST",
        body: payload,
        token: session.token,
        // One key per draft submission: retries cannot create duplicates.
        idempotencyKey: crypto.randomUUID(),
      });
      setCampaignId(data.id);
      window.history.replaceState(null, "", `?campaign=${data.id}`);
    });

  /** Reports the creation tx; retries while the API is still reconciling. */
  async function link(id: string, hash: Hash) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const { status } = await api(`/v1/campaigns/${id}/onchain`, {
        method: "POST",
        body: { txHash: hash },
        token: session?.token ?? null,
      });
      if (status === 200) {
        rememberTx(id, null);
        return true;
      }
      setTx({ state: "reconciling", label: "Linking campaign", hash });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return false;
  }

  const createOnchain = () =>
    run(async () => {
      if (!wallet || !session || !campaignId) return;

      // A transaction from an earlier attempt is reconciled, never resent.
      const previous = recallTx(campaignId);
      if (previous) {
        setTx({
          state: "reconciling",
          label: "Linking campaign",
          hash: previous,
        });
        if (await link(campaignId, previous)) {
          setTx({ state: "done", label: "Campaign created", hash: previous });
          await refresh();
        }
        return;
      }

      // An attempt that failed without a hash may still have been broadcast.
      const earlier = recallIntent(campaignId);
      if (earlier) {
        const { data: chainInfo } = await api<{ campaignManager: Address }>(
          "/v1/chain",
        );
        const resolution = await resolveCreateBroadcast(wallet.publicClient, {
          intent: earlier,
          campaignManager: chainInfo.campaignManager,
        });
        if (resolution.kind === "created") {
          rememberIntent(campaignId, null);
          rememberTx(campaignId, resolution.txHash);
          setTx({
            state: "reconciling",
            label: "Linking campaign",
            hash: resolution.txHash,
          });
          if (await link(campaignId, resolution.txHash)) {
            setTx({
              state: "done",
              label: "Campaign created",
              hash: resolution.txHash,
            });
            await refresh();
          }
          return;
        }
        if (resolution.kind === "pending") {
          setTx({
            state: "failed",
            label: "Create campaign on-chain",
            message:
              "An earlier transaction from this wallet is still pending. Wait until it confirms, then press Create again; it will not be sent twice.",
          });
          return;
        }
        // Nothing was broadcast, or the nonce went to something else.
        rememberIntent(campaignId, null);
      }

      const { data: intent } = await api<PublishIntent>(
        `/v1/campaigns/${campaignId}/publish`,
        { method: "POST", token: session.token },
      );
      const args = intent.steps[0]!.args;

      rememberIntent(
        campaignId,
        await prepareBroadcast(wallet.publicClient, wallet.address),
      );
      setTx({ state: "signing", label: "Create campaign on-chain" });
      const hash = await wallet.walletClient.writeContract({
        account: wallet.address,
        chain,
        address: intent.campaignManager,
        abi: campaignManagerAbi,
        functionName: "createCampaign",
        args: [
          BigInt(args.rewardPerCompletion!),
          Number(args.maxCompletions),
          BigInt(args.startTime!),
          BigInt(args.endTime!),
        ],
      });
      rememberTx(campaignId, hash);
      rememberIntent(campaignId, null);
      setTx({ state: "pending", label: "Create campaign on-chain", hash });

      const outcome = await waitForTx(wallet.publicClient, hash);
      if (outcome.kind === "reverted") {
        rememberTx(campaignId, null);
        setTx({
          state: "failed",
          label: "Create campaign on-chain",
          message: "The transaction reverted.",
        });
        return;
      }
      if (await link(campaignId, hash)) {
        setTx({ state: "done", label: "Campaign created", hash });
        await refresh();
      }
    });

  const fund = () =>
    run(async () => {
      if (!wallet || !session || !campaignId) return;
      const current = analytics;
      if (!current?.onchainCampaignId) return;

      const { data: chainInfo } = await api<{
        campaignManager: Address;
        usdc: Address;
      }>("/v1/chain");
      const usdcAddress = chainInfo.usdc;
      const manager = chainInfo.campaignManager;
      const amount = BigInt(current.plannedBudget);
      const allowance = await wallet.publicClient.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet.address, manager],
      });

      if (allowance < amount) {
        setTx({ state: "signing", label: "Approve USDC" });
        const approveHash = await wallet.walletClient.writeContract({
          account: wallet.address,
          chain,
          address: usdcAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [manager, amount],
        });
        setTx({ state: "pending", label: "Approve USDC", hash: approveHash });
        const approved = await waitForTx(wallet.publicClient, approveHash);
        if (approved.kind !== "confirmed") {
          setTx(
            approved.kind === "pending"
              ? {
                  state: "reconciling",
                  label: "Approve USDC",
                  hash: approveHash,
                }
              : {
                  state: "failed",
                  label: "Approve USDC",
                  message: "Reverted.",
                },
          );
          return;
        }
      }

      setTx({ state: "signing", label: "Fund campaign" });
      const fundHash = await wallet.walletClient.writeContract({
        account: wallet.address,
        chain,
        address: manager,
        abi: campaignManagerAbi,
        functionName: "fundCampaign",
        args: [BigInt(current.onchainCampaignId), amount],
      });
      setTx({ state: "pending", label: "Fund campaign", hash: fundHash });
      const funded = await waitForTx(wallet.publicClient, fundHash);
      setTx(
        funded.kind === "confirmed"
          ? {
              state: "done",
              label: "Funded — activates after confirmations",
              hash: fundHash,
            }
          : funded.kind === "pending"
            ? { state: "reconciling", label: "Fund campaign", hash: fundHash }
            : { state: "failed", label: "Fund campaign", message: "Reverted." },
      );
      await refresh();
    });

  return (
    <main className="container">
      <h1>Advertiser</h1>

      <section className="card">
        <h2>Wallet</h2>
        {!wallet ? (
          <button onClick={connect} disabled={busy}>
            Connect wallet
          </button>
        ) : (
          <>
            <p>
              <code>{wallet.address}</code>
              <br />
              Network: {wallet.chainId} {wrongNetwork ? "⚠" : "✓"} (expected{" "}
              {chain.name}, {chainId})
            </p>
            {wrongNetwork && (
              <button onClick={switchNetwork} disabled={busy}>
                Switch to {chain.name}
              </button>
            )}
            {!wrongNetwork && !session && (
              <button onClick={signIn} disabled={busy}>
                Sign in with Ethereum
              </button>
            )}
            {session && (
              <p>
                Signed in until {new Date(session.expiresAt).toLocaleString()}
              </p>
            )}
            <button
              className="secondary"
              onClick={() => {
                setWallet(null);
                setSession(null);
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </section>

      {session && !campaignId && (
        <CampaignForm
          advertiser={wallet!.address}
          busy={busy}
          onSubmit={createDraft}
        />
      )}

      {session && campaignId && (
        <section className="card">
          <h2>Campaign</h2>
          <p>
            <code>{campaignId}</code>
          </p>
          {analytics ? (
            <dl>
              <dt>Status</dt>
              <dd>{analytics.status}</dd>
              <dt>Planned budget</dt>
              <dd>{usdc(analytics.plannedBudget)}</dd>
              <dt>Accepted / rejected submissions</dt>
              <dd>
                {analytics.submissions.accepted} /{" "}
                {analytics.submissions.rejected}
              </dd>
              <dt>Quality-adjusted accepted</dt>
              <dd>
                {analytics.submissions.adjustedAccepted}
                {analytics.submissions.flaggedAccepted > 0 &&
                  ` (${Object.entries(analytics.submissions.flagReasons)
                    .map(([reason, count]) => `${reason} ×${count}`)
                    .join(", ")})`}
              </dd>
              {analytics.settlement && (
                <>
                  <dt>Funded (confirmed)</dt>
                  <dd>{usdc(analytics.settlement.confirmed.funded)}</dd>
                  <dt>Paid rewards</dt>
                  <dd>
                    {usdc(analytics.settlement.confirmed.paidRewards)} (
                    {analytics.settlement.confirmed.paidCompletions}{" "}
                    completions)
                  </dd>
                  <dt>Remaining</dt>
                  <dd>{usdc(analytics.settlement.confirmed.remaining)}</dd>
                </>
              )}
            </dl>
          ) : (
            <p>Loading…</p>
          )}
          {analytics?.status === "active" && (
            <p>
              Participant link:{" "}
              <a href={`/mission?campaign=${campaignId}`}>
                {`/mission?campaign=${campaignId}`}
              </a>
            </p>
          )}
          {analytics?.settlement?.hasUnconfirmedEvents && (
            <p className="note">
              Some on-chain activity is still being confirmed.
            </p>
          )}
          <div className="actions">
            {analytics?.status === "draft" && (
              <button onClick={createOnchain} disabled={busy || wrongNetwork}>
                Create on-chain
              </button>
            )}
            {analytics?.status === "pending_onchain" &&
              (analytics.settlement?.pending.funded ?? "0") === "0" && (
                <button onClick={fund} disabled={busy || wrongNetwork}>
                  Approve &amp; fund
                </button>
              )}
            <button className="secondary" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </section>
      )}

      {tx.state !== "idle" && (
        <section className={`card tx ${tx.state}`} aria-live="polite">
          <strong>{tx.label}</strong>{" "}
          {tx.state === "signing" && "— confirm in your wallet…"}
          {tx.state === "pending" && "— waiting for the transaction…"}
          {tx.state === "reconciling" &&
            "— still confirming. Do not send it again; this page keeps checking."}
          {tx.state === "done" && "— done."}
          {tx.state === "failed" && `— ${tx.message}`}
          {"hash" in tx && (
            <p>
              <code>{tx.hash}</code>
            </p>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
