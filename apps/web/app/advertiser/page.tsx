"use client";

import { campaignManagerAbi } from "@vham/shared/contracts";
import { isCurrentDeployment, type Deployment } from "@vham/shared/deployment";
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
  chainId: number;
  onchainCampaignId: string | null;
  /** CampaignManager the on-chain id belongs to (ADR-0011). */
  onchainContractAddress: string | null;
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
  | { state: "reconciling"; label: string; hash: Hash | null }
  | { state: "done"; label: string; hash: Hash | null }
  | { state: "failed"; label: string; message: string };

const usdc = (atomic: string) =>
  `${formatUnits(BigInt(atomic), USDC_DECIMALS)} USDC`;

export default function AdvertiserPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tx, setTx] = useState<TxStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The CampaignManager this API is configured for. */
  const [deployment, setDeployment] = useState<Deployment | null>(null);

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
    void api<{ chainId: number; campaignManager: string }>("/v1/chain")
      .then(({ data }) =>
        setDeployment({
          chainId: data.chainId,
          contractAddress: data.campaignManager,
        }),
      )
      .catch(() => setDeployment(null));
  }, []);

  /**
   * On-chain ids restart on every deployment: only a campaign linked on the
   * configured chain and contract may be funded here, otherwise its id
   * would address another campaign on the new contract (ADR-0011).
   */
  const onCurrentDeployment =
    analytics !== null &&
    isCurrentDeployment(
      {
        chainId: analytics.chainId,
        contractAddress: analytics.onchainContractAddress,
      },
      deployment,
    );

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

  /**
   * Links the draft to its on-chain campaign: by transaction hash when known,
   * otherwise by draft reference (ADR-0011). Retries while the API is still
   * reconciling. `attempts: 1` only checks.
   */
  async function link(id: string, hash: Hash | null, attempts = 24) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { status } = await api(`/v1/campaigns/${id}/onchain`, {
        method: "POST",
        body: hash ? { txHash: hash } : {},
        token: session?.token ?? null,
      });
      if (status === 200) return true;
      if (attempt + 1 < attempts) {
        setTx({ state: "reconciling", label: "Linking campaign", hash });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    return false;
  }

  /**
   * createCampaign carries the draft's reference, and the contract refuses a
   * second campaign for the same (advertiser, draft). So a retry, a second tab
   * or a lost RPC response can never create two campaigns, and nothing has to
   * be remembered in the browser (#13, ADR-0011).
   */
  const createOnchain = () =>
    run(async () => {
      if (!wallet || !session || !campaignId) return;
      const label = "Create campaign on-chain";

      // Already created (another tab, an earlier attempt, a lost response)?
      if (await link(campaignId, null, 1)) {
        setTx({ state: "done", label: "Campaign created", hash: null });
        await refresh();
        return;
      }

      const { data: intent } = await api<PublishIntent>(
        `/v1/campaigns/${campaignId}/publish`,
        { method: "POST", token: session.token },
      );
      const args = intent.steps[0]!.args;

      setTx({ state: "signing", label });
      let hash: Hash;
      try {
        hash = await wallet.walletClient.writeContract({
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
            args.draftRef as Hash,
          ],
        });
      } catch (caught) {
        // The transaction may have been broadcast before the error. Look for
        // it by draft reference; pressing Create again is safe either way.
        if (await link(campaignId, null)) {
          setTx({ state: "done", label: "Campaign created", hash: null });
          await refresh();
          return;
        }
        throw caught;
      }

      setTx({ state: "pending", label, hash });
      const mined = await waitForTx(wallet.publicClient, hash);
      if (mined.kind === "reverted") {
        // Usually DraftAlreadyCreated: another attempt created it first.
        if (await link(campaignId, null, 1)) {
          setTx({ state: "done", label: "Campaign created", hash });
          await refresh();
          return;
        }
        setTx({ state: "failed", label, message: "The transaction reverted." });
        return;
      }

      setTx({ state: "reconciling", label: "Linking campaign", hash });
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
        chainId: number;
        campaignManager: Address;
        usdc: Address;
      }>("/v1/chain");
      if (
        !isCurrentDeployment(
          {
            chainId: current.chainId,
            contractAddress: current.onchainContractAddress,
          },
          {
            chainId: chainInfo.chainId,
            contractAddress: chainInfo.campaignManager,
          },
        )
      ) {
        throw new Error(
          "This campaign was created on an earlier CampaignManager deployment and cannot be funded here.",
        );
      }
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
          {analytics?.onchainCampaignId !== null &&
            analytics !== null &&
            deployment !== null &&
            !onCurrentDeployment && (
              <p className="note">
                This campaign belongs to an earlier CampaignManager deployment.
                It cannot be funded or joined here; create a new campaign.
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
              onCurrentDeployment &&
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
          {"hash" in tx && tx.hash && (
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
