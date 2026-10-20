"use client";

import {
  closeAvailability,
  refundAvailability,
  type CloseAvailability,
  type RefundAvailability,
} from "@vham/shared";
import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  isCurrentDeployment,
  isFundingTarget,
  type Deployment,
} from "@vham/shared/deployment";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseAbi, type Address, type Hash } from "viem";

import { api, describeError } from "../../lib/api";
import { chain, chainId, USDC_DECIMALS } from "../../lib/config";
import {
  describeChainError,
  describeSimulationFailure,
  formatRemaining,
  readSettlement,
  SETTLEMENT_CALLS,
  type ChainSettlement,
  type SettlementAction,
  type SettlementTarget,
} from "../../lib/settlement";
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
  draftRef: Hash;
  rewardPerCompletion: string;
  maxCompletions: number;
  startAt: string;
  endAt: string;
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
    pending: {
      funded: string;
      status:
        "not_found" | "created" | "active" | "closed" | "settled" | "cancelled";
    };
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

/** The campaign as the connected wallet reads it from the chain. */
type ChainView =
  | { state: "unread" }
  | { state: "read"; onchain: ChainSettlement }
  | { state: "failed"; message: string };

const UNREAD: ChainView = { state: "unread" };

function settlementTarget(analytics: Analytics): SettlementTarget | null {
  return analytics.onchainCampaignId === null
    ? null
    : {
        onchainCampaignId: analytics.onchainCampaignId,
        rewardPerCompletion: analytics.rewardPerCompletion,
        maxCompletions: analytics.maxCompletions,
        startAt: analytics.startAt,
        endAt: analytics.endAt,
        draftRef: analytics.draftRef,
      };
}

/** Counts down from the last chain read, so it needs no extra RPC calls. */
function Countdown({
  availableAt,
  onchain,
}: {
  availableAt: bigint;
  onchain: ChainSettlement;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, Math.floor((nowMs - onchain.readAtMs) / 1_000));
  const remaining = Number(availableAt - onchain.reading.now) - elapsed;
  return remaining > 0 ? `in ${formatRemaining(remaining)}` : "any moment now";
}

function SettlementNotes({
  onchain,
  close,
  refund,
}: {
  onchain: ChainSettlement;
  close: CloseAvailability | null;
  refund: RefundAvailability | null;
}) {
  return (
    <>
      {close?.kind === "unavailable" && close.reason === "ending-soon" && (
        <p className="note">
          A close sent in the last minute before the end would probably be mined
          too late, so it is not offered.
        </p>
      )}
      {refund?.kind === "waiting" && (
        <p className="note">
          Refund opens at{" "}
          {new Date(Number(refund.availableAt) * 1_000).toLocaleString()} (
          <Countdown availableAt={refund.availableAt} onchain={onchain} />
          ). A claim authorization issued right before the close or end time
          stays valid for {Number(onchain.reading.ttl / 60n)} minutes, so the
          contract holds the unused budget until every one has expired.
        </p>
      )}
      {refund?.kind === "unavailable" && refund.reason === "paused" && (
        <p className="note">
          Refunds are paused by the contract owner and resume after the contract
          is unpaused.
        </p>
      )}
    </>
  );
}

/**
 * Per-draft marker that a createCampaign transaction may have been broadcast
 * (set right before the wallet is asked to send, cleared once the draft is
 * linked or the wallet refused). It survives a reload, so the page offers
 * "Check again" first instead of a second send that would only revert
 * (DraftAlreadyCreated) and cost gas.
 */
const attemptKey = (campaignId: string) => `vham:create-attempt:${campaignId}`;
function rememberAttempt(campaignId: string, at: number | null) {
  try {
    if (at === null) localStorage.removeItem(attemptKey(campaignId));
    else localStorage.setItem(attemptKey(campaignId), String(at));
  } catch {
    // Storage may be unavailable (private mode); the flow still works.
  }
}
function recallAttempt(campaignId: string): number | null {
  try {
    const raw = localStorage.getItem(attemptKey(campaignId));
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}
/** After this long a pending creation is assumed dropped; Create is offered again. */
const RETRY_CREATE_AFTER_MS = 10 * 60_000;

/** EIP-1193 4001: the user rejected the request, so nothing was sent. */
function isUserRejection(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 10;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const candidate = current as { code?: unknown; name?: unknown };
    if (
      candidate.code === 4001 ||
      candidate.name === "UserRejectedRequestError"
    ) {
      return true;
    }
  }
  return false;
}

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
  /**
   * A create may have been broadcast but is not linked yet. Only checking is
   * offered: sending again would just revert (DraftAlreadyCreated) and cost
   * gas.
   */
  const [awaitingLink, setAwaitingLink] = useState(false);
  const [chainView, setChainView] = useState<ChainView>(UNREAD);
  /**
   * A close or refund this page broadcast whose effect is not visible yet. Its
   * button stays hidden: sending it again would only revert and cost gas.
   */
  const [sent, setSent] = useState<SettlementAction | null>(null);
  /** Lets only the most recently started chain read apply its result. */
  const chainReads = useRef(0);

  const wrongNetwork = wallet !== null && wallet.chainId !== chainId;

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("campaign");
    if (id) {
      setCampaignId(id);
      // A creation may still be pending from before a reload.
      setAwaitingLink(recallAttempt(id) !== null);
    }
  }, []);

  /** The draft is linked: no creation can be pending any more. */
  const linked = useCallback((id: string) => {
    rememberAttempt(id, null);
    setAwaitingLink(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!campaignId || !session) return;
    try {
      const { data } = await api<Analytics>(
        `/v1/campaigns/${campaignId}/analytics`,
        { token: session.token },
      );
      setAnalytics(data);
      if (data.status !== "draft") linked(campaignId);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [campaignId, session, linked]);

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

  /**
   * Close and refund depend on block time and the contract's own state, so the
   * wallet reads them from the chain on every analytics refresh. Only funded
   * campaigns on the current deployment have anything to read.
   */
  const readChain = useCallback(async () => {
    const read = ++chainReads.current;
    const target = analytics ? settlementTarget(analytics) : null;
    if (
      !wallet ||
      !deployment ||
      !analytics ||
      !target ||
      !onCurrentDeployment ||
      (analytics.status !== "active" && analytics.status !== "closed")
    ) {
      setChainView(UNREAD);
      return;
    }
    try {
      const settlement = await readSettlement(wallet, deployment, target);
      if (read === chainReads.current) {
        setChainView({ state: "read", onchain: settlement });
      }
    } catch (caught) {
      if (read === chainReads.current) {
        setChainView({ state: "failed", message: describeChainError(caught) });
      }
    }
  }, [wallet, deployment, analytics, onCurrentDeployment]);

  useEffect(() => {
    void readChain();
  }, [readChain]);

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      // A throw while the card still asks for a signature means the wallet
      // call itself failed, so nothing is waiting any more.
      setTx((current) =>
        current.state === "signing" ? { state: "idle" } : current,
      );
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
        linked(campaignId);
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
      // From here on a transaction may exist even if this page never learns
      // its hash (reload, lost response): remember it before asking the wallet.
      rememberAttempt(campaignId, Date.now());
      setAwaitingLink(true);
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
        // Rejected in the wallet: nothing was sent.
        if (isUserRejection(caught)) {
          linked(campaignId);
          throw caught;
        }
        if (await link(campaignId, null)) {
          linked(campaignId);
          setTx({ state: "done", label: "Campaign created", hash: null });
          await refresh();
          return;
        }
        setTx({
          state: "failed",
          label: "Linking campaign",
          message:
            "Not confirmed yet. If the transaction was sent it may still be mined. Press Check again; checking never sends a transaction.",
        });
        return;
      }

      setTx({ state: "pending", label, hash });
      const mined = await waitForTx(wallet.publicClient, hash);
      if (mined.kind === "reverted") {
        // Usually DraftAlreadyCreated: another attempt created it first.
        if (await link(campaignId, null, 1)) {
          linked(campaignId);
          setTx({ state: "done", label: "Campaign created", hash });
          await refresh();
          return;
        }
        setTx({ state: "failed", label, message: "The transaction reverted." });
        return;
      }

      setTx({ state: "reconciling", label: "Linking campaign", hash });
      if (await link(campaignId, hash)) {
        linked(campaignId);
        setTx({ state: "done", label: "Campaign created", hash });
        await refresh();
      } else {
        setTx({
          state: "failed",
          label: "Linking campaign",
          message:
            "Not confirmed yet. If the transaction was sent it may still be mined. Press Check again; checking never sends a transaction.",
        });
      }
    });

  /** Looks for the creation by draft reference; never sends anything. */
  const checkLink = () =>
    run(async () => {
      if (!session || !campaignId) return;
      if (await link(campaignId, null, 1)) {
        linked(campaignId);
        setTx({ state: "done", label: "Campaign created", hash: null });
        await refresh();
        return;
      }
      setTx({
        state: "failed",
        label: "Linking campaign",
        message:
          "Still not confirmed. Check your wallet's activity and try again in a minute.",
      });
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

      // Read the target in the wallet's own chain view right before money
      // moves: the id must still be this draft's, with its parameters. After
      // a deep reorg another draft can hold the same id and budget.
      if ((await wallet.walletClient.getChainId()) !== chainInfo.chainId) {
        throw new Error("Switch your wallet to the campaign's network first.");
      }
      const [mappedCampaignId, onchain] = await Promise.all([
        wallet.publicClient.readContract({
          address: manager,
          abi: campaignManagerAbi,
          functionName: "campaignIdByDraft",
          args: [wallet.address, current.draftRef],
        }),
        wallet.publicClient.readContract({
          address: manager,
          abi: campaignManagerAbi,
          functionName: "campaigns",
          args: [BigInt(current.onchainCampaignId)],
        }),
      ]);
      if (
        !isFundingTarget(
          {
            mappedCampaignId,
            onchain: {
              rewardPerCompletion: onchain[3],
              maxCompletions: onchain[4],
              startTime: onchain[6],
              endTime: onchain[7],
            },
          },
          {
            onchainCampaignId: current.onchainCampaignId,
            rewardPerCompletion: current.rewardPerCompletion,
            maxCompletions: current.maxCompletions,
            startAt: current.startAt,
            endAt: current.endAt,
          },
        )
      ) {
        throw new Error(
          "The on-chain campaign does not match this draft, so nothing was funded. Refresh the page; if it persists, the chain may be recovering.",
        );
      }

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
        // The contract re-checks the draft reference inside the funding
        // transaction, closing the gap between this page's read and the
        // moment the money moves (ADR-0011).
        args: [BigInt(current.onchainCampaignId), amount, current.draftRef],
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

  /**
   * Close and refund carry only the campaign id, so the id is re-read and
   * matched to this draft right before sending (readSettlement). The
   * simulation then names whatever the contract would reject. Nothing is
   * retried: a wallet rejection, a revert or an unknown outcome is shown as is.
   */
  const settle = (action: SettlementAction) =>
    run(async () => {
      if (!wallet || !session || !analytics) return;
      const target = settlementTarget(analytics);
      if (!target) return;
      const { functionName, label, done } = SETTLEMENT_CALLS[action];

      const { data: chainInfo } = await api<{
        chainId: number;
        campaignManager: Address;
      }>("/v1/chain");
      const configured = {
        chainId: chainInfo.chainId,
        contractAddress: chainInfo.campaignManager,
      };
      if (
        !isCurrentDeployment(
          {
            chainId: analytics.chainId,
            contractAddress: analytics.onchainContractAddress,
          },
          configured,
        )
      ) {
        throw new Error(
          "This campaign was created on an earlier CampaignManager deployment and cannot be settled here.",
        );
      }

      const settlement = await readSettlement(wallet, configured, target);
      setChainView({ state: "read", onchain: settlement });
      const verdict =
        action === "close"
          ? closeAvailability(settlement.reading)
          : refundAvailability(settlement.reading);
      if (verdict.kind !== "available") {
        throw new Error(
          "This is no longer available. The page has been updated.",
        );
      }

      const call = {
        account: wallet.address,
        address: chainInfo.campaignManager,
        abi: campaignManagerAbi,
        functionName,
        args: [BigInt(target.onchainCampaignId)],
      } as const;
      try {
        await wallet.publicClient.simulateContract(call);
      } catch (caught) {
        throw new Error(describeSimulationFailure(caught), { cause: caught });
      }

      setTx({ state: "signing", label });
      let hash: Hash;
      try {
        hash = await wallet.walletClient.writeContract({ ...call, chain });
      } catch (caught) {
        throw new Error(
          isUserRejection(caught)
            ? "You rejected the request in your wallet, so nothing was sent."
            : describeChainError(caught),
          { cause: caught },
        );
      }

      setSent(action);
      setTx({ state: "pending", label, hash });
      const mined = await waitForTx(wallet.publicClient, hash);
      if (mined.kind === "pending") {
        setTx({ state: "reconciling", label, hash });
        return;
      }
      if (mined.kind === "reverted") {
        setSent(null);
        setTx({ state: "failed", label, message: "The transaction reverted." });
      } else {
        setTx({ state: "done", label: done, hash });
      }
      await Promise.all([refresh(), readChain()]);
    });

  const apiStatus = analytics?.settlement?.pending.status;
  const onchain = chainView.state === "read" ? chainView.onchain : null;
  const closeVerdict =
    onchain &&
    analytics?.status === "active" &&
    apiStatus !== "closed" &&
    apiStatus !== "settled"
      ? closeAvailability(onchain.reading)
      : null;
  const refundVerdict =
    onchain &&
    (analytics?.status === "active" || analytics?.status === "closed") &&
    apiStatus !== "settled"
      ? refundAvailability(onchain.reading)
      : null;
  const closeOffered =
    closeVerdict?.kind === "available" && !busy && sent !== "close";
  const refundOffered =
    refundVerdict?.kind === "available" && !busy && sent !== "refund";

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
          {chainView.state === "failed" && (
            <p className="note">
              Could not read the campaign from the chain ({chainView.message}).
              Close and refund stay hidden until it works.
            </p>
          )}
          {onchain && (
            <SettlementNotes
              onchain={onchain}
              close={closeVerdict}
              refund={refundVerdict}
            />
          )}
          <div className="actions">
            {analytics?.status === "draft" && !awaitingLink && (
              <button onClick={createOnchain} disabled={busy || wrongNetwork}>
                Create on-chain
              </button>
            )}
            {analytics?.status === "draft" && awaitingLink && (
              <>
                <button onClick={checkLink} disabled={busy}>
                  Check again
                </button>
                {(() => {
                  const attemptAt = recallAttempt(campaignId);
                  return attemptAt !== null &&
                    Date.now() - attemptAt > RETRY_CREATE_AFTER_MS ? (
                    <button
                      className="secondary"
                      onClick={createOnchain}
                      disabled={busy || wrongNetwork}
                      title="If the earlier transaction was mined after all, this one reverts (DraftAlreadyCreated) and only costs gas."
                    >
                      Create on-chain anyway
                    </button>
                  ) : null;
                })()}
              </>
            )}
            {analytics?.status === "pending_onchain" &&
              onCurrentDeployment &&
              (analytics.settlement?.pending.funded ?? "0") === "0" && (
                <button onClick={fund} disabled={busy || wrongNetwork}>
                  Approve &amp; fund
                </button>
              )}
            {closeOffered && (
              <button
                className="secondary"
                onClick={() => settle("close")}
                disabled={wrongNetwork}
                title="Ends the campaign now. Claim authorizations already issued stay payable until they expire; no new ones are issued."
              >
                Close campaign
              </button>
            )}
            {refundOffered && (
              <button onClick={() => settle("refund")} disabled={wrongNetwork}>
                Refund unused budget
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
