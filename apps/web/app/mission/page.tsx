"use client";

import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  newWorldIdSignalSalt,
  worldIdSignal,
  type WorldIdSignalInput,
} from "@vham/shared/world-id";
import {
  CredentialRequest,
  IDKitRequestWidget,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, type Address, type Hash, type Hex } from "viem";

import { api, describeError } from "../../lib/api";
import { chain, chainId, USDC_DECIMALS } from "../../lib/config";
import { connectWallet, waitForTx, type Wallet } from "../../lib/wallet";

interface Campaign {
  id: string;
  status: string;
  rewardPerCompletion: string;
  startAt: string;
  endAt: string;
}

/** Public mission payload: never contains the answer key. */
interface Mission {
  campaignId: string;
  contentUrl: string;
  questions: {
    id: string;
    prompt: string;
    choices: { id: string; label: string }[];
  }[];
}

interface Authorization {
  campaignId: string;
  /** The campaign's draft reference, checked by the contract (ADR-0011). */
  draftRef: Hex;
  claimant: Address;
  amount: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
  contractAddress: Address;
}

interface LiveWorldIdRequest {
  mode: "live";
  appId: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  rpContext: RpContext;
}

type WorldIdRequest =
  LiveWorldIdRequest | { mode: "simulated"; action: string };

interface PendingVerification {
  request: LiveWorldIdRequest;
  binding: WorldIdSignalInput;
}

type Step =
  | { kind: "verify" }
  | { kind: "answer" }
  | { kind: "rejected"; code: string }
  | { kind: "claim"; submissionId: string }
  | { kind: "pending"; hash: Hash }
  | { kind: "paid"; hash: Hash | null };

function progressKey(campaignId: string, wallet: string, name: string) {
  return `vham:${campaignId.toLowerCase()}:${wallet.toLowerCase()}:${name}`;
}

/** Per-browser progress so a reload never repeats a completed step. */
function store<T>(key: string, value?: T | null): T | null {
  try {
    if (value === undefined) {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the flow still works within this page view.
  }
  return value ?? null;
}

export default function MissionPage() {
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [eligibilityToken, setEligibilityToken] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>({ kind: "verify" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingVerification | null>(null);

  const key = (name: string) =>
    progressKey(campaignId ?? "", wallet?.address ?? "", name);
  const constraints = useMemo(
    () =>
      pending &&
      CredentialRequest("proof_of_human", {
        signal: worldIdSignal(pending.binding),
      }),
    [pending],
  );
  const closeWidget = useCallback((open: boolean) => {
    if (!open) setPending(null);
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("campaign");
    setCampaignId(id);
    if (!id) return;
    void (async () => {
      try {
        const [loadedCampaign, loadedMission] = await Promise.all([
          api<Campaign>(`/v1/campaigns/${id}`),
          api<Mission>(`/v1/campaigns/${id}/mission`),
        ]);
        setCampaign(loadedCampaign.data);
        setMission(loadedMission.data);
      } catch (caught) {
        setError(describeError(caught));
      }
    })();
  }, []);

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
      const connected = await connectWallet();
      setWallet(connected);
      const saved = (name: string) =>
        store<string>(progressKey(campaignId ?? "", connected.address, name));
      const token = saved("eligibility");
      const submissionId = saved("submission");
      if (token) setEligibilityToken(token);
      if (submissionId) setStep({ kind: "claim", submissionId });
      else if (token) setStep({ kind: "answer" });
    });

  async function verifyEligibility(
    binding: WorldIdSignalInput,
    idkitResponse: unknown,
  ): Promise<void> {
    const { data } = await api<{ eligibilityToken: string }>(
      `/v1/campaigns/${binding.campaignId}/eligibility/verify`,
      {
        method: "POST",
        body: {
          claimant: binding.claimant,
          signalSalt: binding.salt,
          idkitResponse,
        },
      },
    );
    store(
      progressKey(binding.campaignId, binding.claimant, "eligibility"),
      data.eligibilityToken,
    );
    setEligibilityToken(data.eligibilityToken);
  }

  const verifyHuman = () =>
    run(async () => {
      if (!wallet || !campaign) return;
      const { data } = await api<WorldIdRequest>(
        `/v1/campaigns/${campaign.id}/world-id/request`,
        { method: "POST" },
      );
      const binding: WorldIdSignalInput = {
        campaignId: campaign.id,
        claimant: wallet.address,
        salt: newWorldIdSignalSalt(),
      };
      if (data.mode === "simulated") {
        // Local anvil demo only: the API refuses simulated proofs elsewhere.
        await verifyEligibility(binding, {
          action: data.action,
          simulatedHuman: binding.claimant.toLowerCase(),
          signal: worldIdSignal(binding),
        });
        setStep({ kind: "answer" });
        return;
      }
      setPending({ request: data, binding });
    });

  /** Throwing here makes the widget show its error state (host rejected). */
  async function handleWorldIdVerify(result: IDKitResult) {
    if (!pending) throw new Error("Start the verification again.");
    try {
      await verifyEligibility(pending.binding, result);
    } catch (caught) {
      const message = describeError(caught);
      setError(message);
      throw new Error(message, { cause: caught });
    }
  }

  const submit = () =>
    run(async () => {
      if (!wallet || !campaignId || !eligibilityToken || !mission) return;
      // Stable per attempt: retrying the same request cannot double-submit.
      const attemptKey =
        store<string>(key("attempt")) ??
        store(key("attempt"), crypto.randomUUID())!;
      const { data } = await api<{
        submissionId: string;
        status: "accepted" | "rejected";
        rejectionCode: string | null;
      }>(`/v1/campaigns/${campaignId}/submissions`, {
        method: "POST",
        idempotencyKey: attemptKey,
        body: {
          eligibilityToken,
          claimant: wallet.address,
          answers: mission.questions.map((question) => ({
            questionId: question.id,
            choiceId: answers[question.id] ?? "",
          })),
        },
      });
      store(key("attempt"), null);
      if (data.status === "accepted") {
        store(key("submission"), data.submissionId);
        setStep({ kind: "claim", submissionId: data.submissionId });
      } else {
        setStep({ kind: "rejected", code: data.rejectionCode ?? "REJECTED" });
      }
    });

  const claim = () =>
    run(async () => {
      if (
        !wallet ||
        !campaignId ||
        !eligibilityToken ||
        step.kind !== "claim"
      ) {
        return;
      }
      // Re-requesting after expiry returns a fresh authorization.
      const { data: auth } = await api<Authorization>(
        `/v1/campaigns/${campaignId}/submissions/${step.submissionId}/authorization`,
        { method: "POST", body: { eligibilityToken } },
      );
      const hash = await wallet.walletClient.writeContract({
        account: wallet.address,
        chain,
        address: auth.contractAddress,
        abi: campaignManagerAbi,
        functionName: "claim",
        args: [
          {
            campaignId: BigInt(auth.campaignId),
            draftRef: auth.draftRef,
            claimant: auth.claimant,
            amount: BigInt(auth.amount),
            nonce: auth.nonce,
            issuedAt: BigInt(auth.issuedAt),
            expiresAt: BigInt(auth.expiresAt),
          },
          auth.signature,
        ],
      });
      setStep({ kind: "pending", hash });
      const outcome = await waitForTx(wallet.publicClient, hash);
      if (outcome.kind === "confirmed") {
        setStep({ kind: "paid", hash });
      } else if (outcome.kind === "reverted") {
        setStep({ kind: "claim", submissionId: step.submissionId });
        setError("The claim transaction reverted. You can request it again.");
      }
    }).catch(() => undefined);

  useEffect(() => {
    if (error?.includes("already paid")) setStep({ kind: "paid", hash: null });
  }, [error]);

  if (!campaignId) {
    return (
      <main className="container">
        <p className="error">Missing ?campaign=&lt;id&gt; in the link.</p>
      </main>
    );
  }

  const active = campaign?.status === "active";
  const wrongNetwork = wallet !== null && wallet.chainId !== chainId;

  return (
    <main className="container">
      <h1>
        Earn{" "}
        {campaign
          ? `${formatUnits(BigInt(campaign.rewardPerCompletion), USDC_DECIMALS)} USDC`
          : "USDC"}
      </h1>
      {campaign && !active && (
        <p className="note">
          This campaign is {campaign.status}. Rewards can only be earned while
          it is active ({new Date(campaign.startAt).toLocaleString()} –{" "}
          {new Date(campaign.endAt).toLocaleString()}).
        </p>
      )}

      <section className="card">
        <h2>1. Wallet</h2>
        {!wallet ? (
          <button onClick={connect} disabled={busy}>
            Connect wallet
          </button>
        ) : (
          <p>
            <code>{wallet.address}</code>
            {wrongNetwork && (
              <>
                <br />
                <span className="error">
                  Switch your wallet to {chain.name}.
                </span>
              </>
            )}
          </p>
        )}
      </section>

      {wallet && step.kind === "verify" && (
        <section className="card">
          <h2>2. Prove you are a unique human</h2>
          <p className="note">
            Your reward is bound to this wallet. One person, one reward.
          </p>
          <button
            onClick={verifyHuman}
            disabled={busy || !active || pending !== null}
          >
            Verify with World ID
          </button>
        </section>
      )}

      {pending && constraints && (
        <IDKitRequestWidget
          open
          onOpenChange={closeWidget}
          app_id={pending.request.appId}
          action={pending.request.action}
          rp_context={pending.request.rpContext}
          environment={pending.request.environment}
          allow_legacy_proofs={false}
          constraints={constraints}
          handleVerify={handleWorldIdVerify}
          onSuccess={() => {
            setError(null);
            setStep({ kind: "answer" });
          }}
          onError={(errorCode) => {
            // The API's reason was already shown by handleWorldIdVerify.
            if (errorCode === "failed_by_host_app") return;
            // Code only: the debug report can carry request details.
            setError(`World ID verification did not complete (${errorCode}).`);
          }}
        />
      )}

      {wallet &&
        mission &&
        (step.kind === "answer" || step.kind === "rejected") && (
          <section className="card">
            <h2>3. Read and answer</h2>
            <p>
              <a
                href={mission.contentUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the sponsored content ↗
              </a>
            </p>
            {mission.questions.map((question) => (
              <fieldset key={question.id}>
                <legend>{question.prompt}</legend>
                {question.choices.map((choice) => (
                  <label className="choice" key={choice.id}>
                    <input
                      type="radio"
                      name={question.id}
                      checked={answers[question.id] === choice.id}
                      onChange={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: choice.id,
                        }))
                      }
                    />
                    {choice.label}
                  </label>
                ))}
              </fieldset>
            ))}
            {step.kind === "rejected" && (
              <p className="error">
                {step.code === "COMPREHENSION_FAILED"
                  ? "Not quite. Re-read the content and try once more."
                  : "Your answers were not accepted."}
              </p>
            )}
            <button onClick={submit} disabled={busy || !active}>
              Submit answers
            </button>
          </section>
        )}

      {wallet && step.kind === "claim" && (
        <section className="card">
          <h2>4. Claim your reward</h2>
          <p className="note">
            You send the claim transaction yourself; it pays this wallet only.
          </p>
          <button onClick={() => void claim()} disabled={busy || wrongNetwork}>
            Claim USDC
          </button>
        </section>
      )}

      {step.kind === "pending" && (
        <section className="card tx" aria-live="polite">
          <strong>Claim sent</strong> — waiting for confirmation. Do not send it
          again.
          <p>
            <code>{step.hash}</code>
          </p>
        </section>
      )}

      {step.kind === "paid" && (
        <section className="card tx done" aria-live="polite">
          <strong>Reward paid to your wallet.</strong>
          {step.hash && (
            <p>
              <code>{step.hash}</code>
            </p>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
