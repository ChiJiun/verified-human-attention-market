"use client";

import { campaignManagerAbi } from "@vham/shared/contracts";
import { isCurrentDeployment, type Deployment } from "@vham/shared/deployment";
import {
  closeAvailability,
  refundAvailability,
  type CloseAvailability,
  type RefundAvailability,
  type UnixSeconds,
} from "@vham/shared/settlement";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address, type Hash } from "viem";

import { useAdvertiserSession } from "../../lib/advertiser-session";
import { api, ApiError, describeError } from "../../lib/api";
import {
  CHECK_AGAIN,
  checkLink,
  createAttemptMarker,
  gaveUpMessage,
  keepChecking,
  retryCreateOffered,
  type LinkCheck,
} from "../../lib/campaign-creation";
import {
  campaignLink,
  campaignPath,
  parseCampaignId,
  type CampaignId,
} from "../../lib/campaign-link";
import { chain, chainId, USDC_DECIMALS } from "../../lib/config";
import {
  allowanceCovers,
  erc20Abi,
  FUNDING_ANYWAY_TITLES,
  FUNDING_CALLS,
  fundingButton,
  fundingButtonLabel,
  fundingEffectVisible,
  fundingOffered,
  isFundingAction,
  nextFundingStep,
  readFunding,
  requiredBudget,
  trackedCall,
  trackedFailure,
  trackedNoun,
  type FundingAction,
  type FundingDeployment,
  type FundingReading,
  type FundingView,
} from "../../lib/funding";
import {
  describeChainError,
  cardFlipsToDone,
  describeSimulationFailure,
  effectMayFlipCard,
  endsAwaitingEffect,
  formatRemaining,
  pollSettlementTx,
  readSettlement,
  SETTLEMENT_CALLS,
  settlementButton,
  settlementEffectVisible,
  type ChainSettlement,
  type FinalSettlementTxOutcome,
  type SettlementAction,
  type SettlementTarget,
  type TrackedAction,
  unresolvedTxCheck,
} from "../../lib/settlement";
import {
  connectWallet,
  waitForTx,
  type TxOutcome,
  type Wallet,
} from "../../lib/wallet";
import { isUserRejection, nothingWasSent } from "../../lib/wallet-errors";
import { CampaignForm, type CampaignPayload } from "./CampaignForm";

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
  | { state: "failed"; label: string; message: string; hash?: Hash | null };

const usdc = (atomic: string) =>
  `${formatUnits(BigInt(atomic), USDC_DECIMALS)} USDC`;

type ChainView =
  | { state: "unread" }
  | { state: "read"; onchain: ChainSettlement }
  | { state: "failed"; message: string };

const UNREAD: ChainView = { state: "unread" };

/** The close, refund, approve or fund transaction this page sent last. */
interface SentTx {
  action: TrackedAction;
  hash: Hash;
}

/**
 * A transaction whose receipt did not arrive while waiting: a close or
 * refund (#86), an approve or fund (#103).
 */
type UnresolvedTx = {
  hash: Hash;
  sentAtMs: number;
  target: SettlementTarget;
} & (
  | { action: SettlementAction; deployment: Deployment }
  | { action: FundingAction; deployment: FundingDeployment }
);

/** What the page knows about the campaign's funding (lib/funding.ts). */
function fundingViewOf(
  analytics: Analytics | null,
  reading: FundingReading | null,
  seenFunded: string | null,
): FundingView | null {
  return analytics === null
    ? null
    : {
        required: requiredBudget(analytics),
        reading,
        indexed: analytics,
        seenFunded: seenFunded === analytics.campaignId,
      };
}

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

function Countdown({
  availableAt,
  onchain,
}: {
  availableAt: UnixSeconds;
  onchain: ChainSettlement;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(
    0,
    Math.floor((nowMs - onchain.readAtLocalMs) / 1_000),
  );
  const remaining =
    Number(availableAt - onchain.reading.blockTimestamp) - elapsed;
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
  const maxAuthorizationMinutes = Number(
    onchain.reading.maxAuthorizationTtl / 60n,
  );
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
          stays valid for {maxAuthorizationMinutes} minutes, so the contract
          holds the unused budget until every one has expired.
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

/** Per-draft "a creation may be pending" marker (lib/campaign-creation.ts). */
const attempts = createAttemptMarker(() => window.localStorage);

export default function AdvertiserPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [campaignId, setCampaignId] = useState<CampaignId | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tx, setTx] = useState<TxStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The CampaignManager (and its USDC) this API is configured for. */
  const [deployment, setDeployment] = useState<FundingDeployment | null>(null);
  /**
   * A create may have been broadcast but is not linked yet. Only checking is
   * offered: sending again would just revert (DraftAlreadyCreated) and cost
   * gas.
   */
  const [awaitingLink, setAwaitingLink] = useState(false);
  const [chainView, setChainView] = useState<ChainView>(UNREAD);
  /**
   * The allowance and the campaign as the wallet's node last showed them
   * while the campaign awaits funding; kept when a read fails, because the
   * funding button reads again before it sends.
   */
  const [fundingReading, setFundingReading] = useState<FundingReading | null>(
    null,
  );
  /** The campaign this page has seen funded; it stays funded (FundingView). */
  const [seenFunded, setSeenFunded] = useState<string | null>(null);
  const [awaitingEffect, setAwaitingEffect] = useState<TrackedAction | null>(
    null,
  );
  /** A transaction whose outcome is unknown; checked until it settles. */
  const [unresolved, setUnresolved] = useState<UnresolvedTx | null>(null);
  /** Hash of the unresolved transaction that was probably never broadcast. */
  const [maybeDropped, setMaybeDropped] = useState<Hash | null>(null);
  /** Kept after a failed verdict, so the card turns done if the effect shows later. */
  const [lastSent, setLastSent] = useState<SentTx | null>(null);
  const chainReads = useRef(0);
  const fundingReads = useRef(0);
  /** Aborted on unmount: stops the linking loop. */
  const lifetime = useRef<AbortController | null>(null);
  const auth = useAdvertiserSession(wallet, setError);
  const activeSession = auth.active;

  const wrongNetwork = wallet !== null && wallet.chainId !== chainId;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const link = campaignLink(window.location.search);
    if (link.kind === "campaign") {
      setCampaignId(link.id);
      // A creation may still be pending from before a reload.
      setAwaitingLink(attempts.recall(link.id) !== null);
    } else if (link.kind === "invalid") {
      setError(
        "This campaign link is not valid. Open the campaign from where you created it, or start a new one.",
      );
    }
  }, []);

  /** The draft is linked: no creation can be pending any more. */
  const linked = useCallback((id: string) => {
    attempts.clear(id);
    setAwaitingLink(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!campaignId || !activeSession) return;
    try {
      const { data } = await api<Analytics>(
        campaignPath(campaignId, "/analytics"),
      );
      setAnalytics(data);
      if (data.status !== "draft") linked(campaignId);
    } catch (caught) {
      setError(describeError(caught));
      void auth.syncFromError(caught);
    }
  }, [campaignId, activeSession, linked, auth.syncFromError]);

  useEffect(() => {
    void api<{ chainId: number; campaignManager: string; usdc: string }>(
      "/v1/chain",
    )
      .then(({ data }) =>
        setDeployment({
          chainId: data.chainId,
          contractAddress: data.campaignManager,
          usdc: data.usdc,
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

  /**
   * While the campaign awaits funding, the allowance and the campaign as the
   * wallet sees them: they label the funding button ("Fund campaign" once
   * the allowance covers the budget) and end the wait for an approve or fund
   * (#103). Re-read on every analytics refresh.
   */
  const readFundingState = useCallback(async () => {
    const read = ++fundingReads.current;
    const target = analytics ? settlementTarget(analytics) : null;
    if (
      !wallet ||
      !deployment ||
      !analytics ||
      !target ||
      !onCurrentDeployment ||
      analytics.status !== "pending_onchain"
    ) {
      setFundingReading(null);
      return;
    }
    try {
      const reading = await readFunding(wallet, deployment, target);
      if (read === fundingReads.current) setFundingReading(reading);
    } catch {
      // Keeps the last reading; the next refresh reads again.
    }
  }, [wallet, deployment, analytics, onCurrentDeployment]);

  useEffect(() => {
    void readFundingState();
  }, [readFundingState]);

  /**
   * Ends the wait for an unknown outcome. Only the card that still shows
   * this transaction changes. A failed one (and a done approval) offers the
   * action again if the chain still allows it; any other done one keeps it
   * hidden until a read shows the effect (below, endsAwaitingEffect).
   */
  const settleUnresolved = useCallback(
    (pending: SentTx, outcome: FinalSettlementTxOutcome) => {
      const { label, done } = trackedCall(pending.action);
      setUnresolved((current) =>
        current?.hash === pending.hash ? null : current,
      );
      setMaybeDropped(null);
      setTx((current) =>
        current.state !== "reconciling" || current.hash !== pending.hash
          ? current
          : outcome === "done"
            ? { state: "done", label: done, hash: pending.hash }
            : {
                state: "failed",
                label,
                message: trackedFailure(pending.action, outcome),
                hash: pending.hash,
              },
      );
      if (endsAwaitingEffect(pending.action, outcome)) {
        setAwaitingEffect((current) =>
          current === pending.action ? null : current,
        );
      }
      if (!effectMayFlipCard(pending.action, outcome)) {
        setLastSent((current) =>
          current?.hash === pending.hash ? null : current,
        );
      }
    },
    [],
  );

  // Once the campaign shows funded, on-chain or in the API's index, it stays
  // funded on this page: a lagging read cannot offer Approve & fund again.
  const fundingNow = fundingViewOf(analytics, fundingReading, null);
  const fundedNow =
    fundingNow !== null && fundingEffectVisible("fund", fundingNow);
  const fundedCampaign = analytics?.campaignId ?? null;
  useEffect(() => {
    if (fundedNow && fundedCampaign) setSeenFunded(fundedCampaign);
  }, [fundedNow, fundedCampaign]);

  // Once the chain (or the API's index of it) shows what an action
  // produces, the wait for it is over, whichever transaction caused it, and
  // a card still showing this page's last transaction for it (waiting, or
  // failed on a lagging backend's answer) turns done (#86, #103).
  const onchainStatus =
    chainView.state === "read" ? chainView.onchain.reading.storedStatus : null;
  useEffect(() => {
    const funding = fundingViewOf(analytics, fundingReading, seenFunded);
    const visible = (action: TrackedAction) =>
      isFundingAction(action)
        ? funding !== null && fundingEffectVisible(action, funding)
        : [
            onchainStatus,
            analytics?.settlement?.pending.status,
            analytics?.status,
          ].some((status) => settlementEffectVisible(action, status));

    if (awaitingEffect && visible(awaitingEffect)) setAwaitingEffect(null);
    if (!lastSent || !visible(lastSent.action)) return;
    const { hash, action } = lastSent;
    setUnresolved((current) => (current?.hash === hash ? null : current));
    setMaybeDropped((current) => (current === hash ? null : current));
    setTx((current) =>
      cardFlipsToDone(current, hash)
        ? { state: "done", label: trackedCall(action).done, hash }
        : current,
    );
  }, [
    awaitingEffect,
    onchainStatus,
    fundingReading,
    seenFunded,
    analytics,
    lastSent,
    tx,
  ]);

  // While the card says "reconciling", check the transaction, the sender's
  // nonce, the receipt and the effect (the campaign, or for an approval the
  // allowance), so a late or replaced transaction resolves without a
  // reload. Nothing is ever sent from here.
  useEffect(() => {
    if (!unresolved || !wallet) return;
    const pending = unresolved;

    /** Whether a fresh read shows the effect; it is made after the observation. */
    const readEffect = async (): Promise<boolean> => {
      if (pending.action === "approve" || pending.action === "fund") {
        const read = ++fundingReads.current;
        const reading = await readFunding(
          wallet,
          pending.deployment,
          pending.target,
        );
        if (read === fundingReads.current) setFundingReading(reading);
        return fundingEffectVisible(pending.action, {
          required: requiredBudget(pending.target),
          reading,
        });
      }
      const read = ++chainReads.current;
      const settlement = await readSettlement(
        wallet,
        pending.deployment,
        pending.target,
      );
      if (read === chainReads.current) {
        setChainView({ state: "read", onchain: settlement });
      }
      return settlementEffectVisible(
        pending.action,
        settlement.reading.storedStatus,
      );
    };

    return pollSettlementTx(
      unresolvedTxCheck({
        wallet,
        chainId: pending.deployment.chainId,
        hash: pending.hash,
        sentAtMs: pending.sentAtMs,
        readEffect,
      }),
      (outcome) => {
        if (outcome === "pending" || outcome === "dropped") {
          // Not final: the "anyway" button comes and goes with it.
          setMaybeDropped(outcome === "dropped" ? pending.hash : null);
          return;
        }
        settleUnresolved(pending, outcome);
        void refresh();
      },
    );
  }, [unresolved, wallet, refresh, settleUnresolved]);

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught));
      void auth.syncFromError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function confirmInWallet<T>(
    label: string,
    walletCall: () => Promise<T>,
  ): Promise<T> {
    setTx({ state: "signing", label });
    try {
      return await walletCall();
    } catch (caught) {
      setTx({ state: "idle" });
      throw caught;
    }
  }

  const connect = () =>
    run(async () => {
      setWallet(await connectWallet());
    });

  const disconnect = () =>
    run(async () => {
      await auth.signOut();
      setWallet(null);
    });

  const signOut = () => run(auth.signOut);

  const switchNetwork = () =>
    run(async () => {
      if (!wallet) return;
      await wallet.walletClient.switchChain({ id: chainId });
      setWallet({ ...wallet, chainId: await wallet.walletClient.getChainId() });
    });

  const signIn = () =>
    run(async () => {
      if (!wallet) return;
      await auth.signIn(wallet);
    });

  const createDraft = (payload: CampaignPayload) =>
    run(async () => {
      if (!activeSession) return;
      const { data } = await api<{ id: string }>("/v1/campaigns", {
        method: "POST",
        body: payload,
        // One key per draft submission: retries cannot create duplicates.
        idempotencyKey: crypto.randomUUID(),
      });
      const id = parseCampaignId(data.id);
      if (!id) throw new Error("The API returned an invalid campaign id.");
      setCampaignId(id);
      window.history.replaceState(null, "", `?campaign=${id}`);
    });

  /**
   * One link request: by transaction hash when known, otherwise by draft
   * reference (ADR-0011). A reconciling answer, including a transient RPC
   * outage (`503`), is "not linked yet", never a failure.
   */
  const checkOnchain = (
    id: CampaignId,
    hash: Hash | null,
  ): Promise<LinkCheck> =>
    checkLink(() =>
      api(campaignPath(id, "/onchain"), {
        method: "POST",
        body: hash ? { txHash: hash } : {},
      }),
    );

  /**
   * Keeps checking for about two minutes while the API reconciles. When it
   * gives up or the API refuses the link, the card says to press Check
   * again; checking never sends a transaction (#78). `walletError` is the
   * wallet's own report when it failed without saying whether it sent. Stops
   * when the page is left.
   */
  async function linkUntilFinal(
    id: CampaignId,
    hash: Hash | null,
    walletError?: string,
  ) {
    const signal = lifetime.current?.signal;
    const reported = walletError
      ? `Your wallet reported: ${walletError.replace(/\.?$/, ".")} `
      : "";
    setTx({ state: "reconciling", label: "Linking campaign", hash });
    let last: LinkCheck;
    try {
      last = await keepChecking(() => checkOnchain(id, hash), {
        attempts: 24,
        delayMs: 5_000,
        signal,
      });
    } catch (caught) {
      if (signal?.aborted) return;
      void auth.syncFromError(caught);
      setTx({
        state: "failed",
        label: "Linking campaign",
        message: `${reported}${describeError(caught)} ${CHECK_AGAIN}`,
      });
      return;
    }
    if (last.kind === "linked") {
      linked(id);
      setTx({ state: "done", label: "Campaign created", hash });
      await refresh();
    } else {
      setTx({
        state: "failed",
        label: "Linking campaign",
        message: `${reported}${gaveUpMessage(last.code)}`,
      });
    }
  }

  /**
   * createCampaign carries the draft's reference, and the contract refuses a
   * second campaign for the same (advertiser, draft). So a retry, a second tab
   * or a lost RPC response can never create two campaigns (#13, ADR-0011).
   * The browser only remembers that a creation may be pending (`attempts`),
   * so that it offers Check again before a send that would just revert
   * (DraftAlreadyCreated) and cost gas.
   */
  const createOnchain = () =>
    run(async () => {
      if (!wallet || !activeSession || !campaignId) return;
      const label = "Create campaign on-chain";

      // Already created and final (another tab, an earlier attempt, a lost
      // response)?
      if ((await checkOnchain(campaignId, null)).kind === "linked") {
        linked(campaignId);
        setTx({ state: "done", label: "Campaign created", hash: null });
        await refresh();
        return;
      }

      // The check above reads only the confirmed block. A creation that is
      // mined but not final yet makes the API refuse the intent instead.
      let intent: PublishIntent;
      try {
        ({ data: intent } = await api<PublishIntent>(
          campaignPath(campaignId, "/publish"),
          { method: "POST" },
        ));
      } catch (caught) {
        if (
          !(caught instanceof ApiError) ||
          caught.code !== "DRAFT_ALREADY_CREATED"
        ) {
          throw caught;
        }
        attempts.begin(campaignId, Date.now());
        setAwaitingLink(true);
        await linkUntilFinal(campaignId, null);
        return;
      }
      const args = intent.steps[0]!.args;

      // From here on a transaction may exist even if this page never learns
      // its hash (reload, lost response): remember it before asking the wallet.
      const undoAttempt = attempts.begin(campaignId, Date.now());
      setAwaitingLink(true);
      let hash: Hash;
      try {
        hash = await confirmInWallet(label, () =>
          wallet.walletClient.writeContract({
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
          }),
        );
      } catch (caught) {
        // Rejected in the wallet, or the wallet is on another chain: nothing
        // was sent now, but the marker of an earlier attempt (before "Create
        // on-chain anyway") stays.
        if (nothingWasSent(caught)) {
          setAwaitingLink(undoAttempt() !== null);
          throw new Error(describeChainError(caught), { cause: caught });
        }
        // The transaction may have been broadcast before the error. Look for
        // it by draft reference, and say what the wallet reported.
        await linkUntilFinal(campaignId, null, describeChainError(caught));
        return;
      }

      setTx({ state: "pending", label, hash });
      const mined = await waitForTx(wallet.publicClient, hash);
      if (mined.kind === "reverted") {
        // Usually DraftAlreadyCreated: another attempt created it first.
        if ((await checkOnchain(campaignId, null)).kind === "linked") {
          linked(campaignId);
          setTx({ state: "done", label: "Campaign created", hash });
          await refresh();
          return;
        }
        setTx({
          state: "failed",
          label,
          message:
            "The transaction reverted. If another attempt created this campaign first, Check again links it.",
        });
        return;
      }

      await linkUntilFinal(campaignId, hash);
    });

  /** Looks for the creation by draft reference; never sends anything. */
  const checkAgain = () =>
    run(async () => {
      if (!activeSession || !campaignId) return;
      const result = await checkOnchain(campaignId, null);
      if (result.kind === "linked") {
        linked(campaignId);
        setTx({ state: "done", label: "Campaign created", hash: null });
        await refresh();
        return;
      }
      setTx({
        state: "failed",
        label: "Linking campaign",
        message: gaveUpMessage(result.code),
      });
    });

  /**
   * Sends one approve or fund and waits for its receipt. A receipt that does
   * not arrive in time is not a failure: like close and refund, the card
   * says "reconciling" and the page keeps checking (#103). Never resent.
   */
  async function sendFundingTx(
    wallet: Wallet,
    deployment: FundingDeployment,
    target: SettlementTarget,
    action: FundingAction,
    write: () => Promise<Hash>,
  ): Promise<TxOutcome["kind"]> {
    const { label, done } = FUNDING_CALLS[action];
    const hash = await confirmInWallet(label, write);

    const sentAtMs = Date.now();
    // A new approve or fund (e.g. "anyway") supersedes an unresolved one.
    setUnresolved((current) =>
      current && isFundingAction(current.action) ? null : current,
    );
    setMaybeDropped(null);
    setLastSent({ action, hash });
    setAwaitingEffect(action);
    setTx({ state: "pending", label, hash });
    const mined = await waitForTx(wallet.publicClient, hash);
    if (mined.kind === "pending") {
      setTx({ state: "reconciling", label, hash });
      setUnresolved({ action, hash, sentAtMs, deployment, target });
      return mined.kind;
    }

    const outcome = mined.kind === "reverted" ? "reverted" : "done";
    // An approval's receipt is its effect, and Fund follows. Fund stays
    // hidden until the funding shows on-chain or in the API's index.
    if (endsAwaitingEffect(action, outcome)) setAwaitingEffect(null);
    if (!effectMayFlipCard(action, outcome)) {
      setLastSent((current) => (current?.hash === hash ? null : current));
    }
    setTx(
      outcome === "done"
        ? { state: "done", label: done, hash }
        : {
            state: "failed",
            label,
            message: trackedFailure(action, outcome),
            hash,
          },
    );
    return mined.kind;
  }

  const fund = () =>
    run(async () => {
      if (!wallet || !activeSession || !campaignId || !analytics) return;
      const target = settlementTarget(analytics);
      if (!target) return;

      const { data: chainInfo } = await api<{
        chainId: number;
        campaignManager: Address;
        usdc: Address;
      }>("/v1/chain");
      const configured: FundingDeployment = {
        chainId: chainInfo.chainId,
        contractAddress: chainInfo.campaignManager,
        usdc: chainInfo.usdc,
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
          "This campaign was created on an earlier CampaignManager deployment and cannot be funded here.",
        );
      }

      // Read the target in the wallet's own chain view right before money
      // moves: the id must still be this draft's, with its parameters. After
      // a deep reorg another draft can hold the same id and budget. An
      // earlier fund that landed after all stops here: nothing is sent.
      const amount = requiredBudget(target);
      const readStep = async (approved: boolean) => {
        const read = ++fundingReads.current;
        const reading = await readFunding(wallet, configured, target);
        if (read === fundingReads.current) setFundingReading(reading);
        const step = nextFundingStep(reading, amount, { approved });
        if (step.kind === "refuse") throw new Error(step.message);
        return step.kind;
      };

      try {
        if ((await readStep(false)) === "approve") {
          const approved = await sendFundingTx(
            wallet,
            configured,
            target,
            "approve",
            () =>
              wallet.walletClient.writeContract({
                account: wallet.address,
                chain,
                address: chainInfo.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [chainInfo.campaignManager, amount],
              }),
          );
          // Unknown: checked until the allowance or the nonce settles it,
          // and "Fund campaign" appears once the allowance shows.
          if (approved !== "confirmed") return;
          // The approval may have waited two minutes: read again right
          // before the money moves (funded elsewhere, allowance overwritten).
          await readStep(true);
        }

        await sendFundingTx(wallet, configured, target, "fund", () =>
          wallet.walletClient.writeContract({
            account: wallet.address,
            chain,
            address: chainInfo.campaignManager,
            abi: campaignManagerAbi,
            functionName: "fundCampaign",
            // The contract re-checks the draft reference inside the funding
            // transaction, closing the gap between this page's read and the
            // moment the money moves (ADR-0011).
            args: [BigInt(target.onchainCampaignId), amount, target.draftRef],
          }),
        );
      } finally {
        // Also after a rejected Fund: the next reads label the button.
        await refresh();
      }
    });

  async function prepareSettlement(
    wallet: Wallet,
    analytics: Analytics,
    target: SettlementTarget,
    action: SettlementAction,
  ): Promise<{ manager: Address; deployment: Deployment }> {
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
    return { manager: chainInfo.campaignManager, deployment: configured };
  }

  async function sendSettlementOnce(
    wallet: Wallet,
    { manager, deployment }: { manager: Address; deployment: Deployment },
    target: SettlementTarget,
    action: SettlementAction,
  ) {
    const { functionName, label, done } = SETTLEMENT_CALLS[action];
    const call = {
      account: wallet.address,
      address: manager,
      abi: campaignManagerAbi,
      functionName,
      args: [BigInt(target.onchainCampaignId)],
    } as const;
    try {
      await wallet.publicClient.simulateContract(call);
    } catch (caught) {
      throw new Error(describeSimulationFailure(caught), { cause: caught });
    }

    let hash: Hash;
    try {
      hash = await confirmInWallet(label, () =>
        wallet.walletClient.writeContract({ ...call, chain }),
      );
    } catch (caught) {
      throw new Error(
        isUserRejection(caught)
          ? "You rejected the request in your wallet, so nothing was sent."
          : describeChainError(caught),
        { cause: caught },
      );
    }

    const sentAtMs = Date.now();
    // A new send (e.g. "anyway") supersedes the earlier unresolved one.
    setUnresolved((current) => (current?.action === action ? null : current));
    setMaybeDropped(null);
    setLastSent({ action, hash });
    setAwaitingEffect(action);
    setTx({ state: "pending", label, hash });
    const mined = await waitForTx(wallet.publicClient, hash);
    if (mined.kind === "pending") {
      // Not a failure: checked until the receipt, the sender's nonce or the
      // campaign's status settles it.
      setTx({ state: "reconciling", label, hash });
      setUnresolved({ action, hash, sentAtMs, deployment, target });
      return;
    }
    if (mined.kind === "reverted") {
      setAwaitingEffect(null);
      setTx({
        state: "failed",
        label,
        message: "The transaction reverted.",
        hash,
      });
    } else {
      setTx({ state: "done", label: done, hash });
    }
    await Promise.all([refresh(), readChain()]);
  }

  const settle = (action: SettlementAction) =>
    run(async () => {
      if (!wallet || !activeSession || !analytics) return;
      const target = settlementTarget(analytics);
      if (!target) return;
      const prepared = await prepareSettlement(
        wallet,
        analytics,
        target,
        action,
      );
      await sendSettlementOnce(wallet, prepared, target, action);
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
  const buttonState = {
    awaitingEffect,
    maybeDropped:
      unresolved !== null && maybeDropped === unresolved.hash
        ? unresolved.action
        : null,
    blocked: busy || wrongNetwork,
  };
  const closeButton = settlementButton("close", closeVerdict, buttonState);
  const refundButton = settlementButton("refund", refundVerdict, buttonState);
  const funding = fundingViewOf(analytics, fundingReading, seenFunded);
  const fundButton = fundingButton(
    fundingOffered(analytics?.status, onCurrentDeployment, funding),
    funding !== null && allowanceCovers(funding.reading, funding.required),
    buttonState,
  );
  const anywayTitle =
    "Your wallet's network has not seen the earlier transaction. If it is mined after all, this one reverts and only costs gas.";

  return (
    <main className="container">
      <h1>Advertiser</h1>

      <section className="card">
        <h2>Wallet</h2>
        {!wallet ? (
          <>
            {auth.session && (
              <p>
                Signed in as <code>{auth.session.address}</code> until{" "}
                {new Date(auth.session.expiresAt).toLocaleString()}. Connect
                that wallet to manage its campaigns.
              </p>
            )}
            <button onClick={connect} disabled={busy}>
              Connect wallet
            </button>
            {auth.session && (
              <button className="secondary" onClick={signOut} disabled={busy}>
                Sign out
              </button>
            )}
          </>
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
            {!wrongNetwork && !activeSession && (
              <button onClick={signIn} disabled={busy}>
                Sign in with Ethereum
              </button>
            )}
            {activeSession ? (
              <p>
                Signed in until{" "}
                {new Date(activeSession.expiresAt).toLocaleString()}
              </p>
            ) : (
              auth.session && (
                <p className="note">
                  This browser is signed in as{" "}
                  <code>{auth.session.address}</code>, not this wallet. Sign in
                  again to manage this wallet&apos;s campaigns.
                </p>
              )
            )}
            <button className="secondary" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </>
        )}
      </section>

      {activeSession && !campaignId && (
        <CampaignForm
          advertiser={wallet!.address}
          busy={busy}
          onSubmit={createDraft}
        />
      )}

      {activeSession && campaignId && (
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
          {buttonState.maybeDropped && (
            <p className="note">
              Your wallet&apos;s network has not seen the{" "}
              {trackedNoun(buttonState.maybeDropped)} transaction for 10
              minutes, so it was probably never broadcast. Check your
              wallet&apos;s activity first; this page keeps checking it.
            </p>
          )}
          <div className="actions">
            {analytics?.status === "draft" && !awaitingLink && (
              <button onClick={createOnchain} disabled={busy || wrongNetwork}>
                Create on-chain
              </button>
            )}
            {analytics?.status === "draft" && awaitingLink && (
              <>
                <button onClick={checkAgain} disabled={busy}>
                  Check again
                </button>
                {retryCreateOffered(
                  attempts.recall(campaignId),
                  Date.now(),
                ) && (
                  <button
                    className="secondary"
                    onClick={createOnchain}
                    disabled={busy || wrongNetwork}
                    title="If the earlier transaction was mined after all, this one reverts (DraftAlreadyCreated) and only costs gas."
                  >
                    Create on-chain anyway
                  </button>
                )}
              </>
            )}
            {fundButton.kind !== "hidden" && (
              <button
                className={
                  fundButton.kind === "send-anyway" ? "secondary" : undefined
                }
                onClick={fund}
                disabled={fundButton.disabled}
                title={
                  fundButton.kind === "send-anyway"
                    ? FUNDING_ANYWAY_TITLES[fundButton.step]
                    : undefined
                }
              >
                {fundingButtonLabel(fundButton)}
              </button>
            )}
            {closeButton.kind !== "hidden" && (
              <button
                className="secondary"
                onClick={() => settle("close")}
                disabled={closeButton.disabled}
                title={
                  closeButton.kind === "send-anyway"
                    ? anywayTitle
                    : "Ends the campaign now. Claim authorizations already issued stay payable until they expire; no new ones are issued."
                }
              >
                {closeButton.kind === "send-anyway"
                  ? "Close campaign anyway"
                  : "Close campaign"}
              </button>
            )}
            {refundButton.kind !== "hidden" && (
              <button
                className={
                  refundButton.kind === "send-anyway" ? "secondary" : undefined
                }
                onClick={() => settle("refund")}
                disabled={refundButton.disabled}
                title={
                  refundButton.kind === "send-anyway" ? anywayTitle : undefined
                }
              >
                {refundButton.kind === "send-anyway"
                  ? "Refund unused budget anyway"
                  : "Refund unused budget"}
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
