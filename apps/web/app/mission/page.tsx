"use client";

import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  IDKitRequestWidget,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { useEffect, useState } from "react";
import { formatUnits, type Address, type Hash, type Hex } from "viem";

import { api, describeError } from "../../lib/api";
import {
  campaignLink,
  campaignPath,
  claimAuthorizationPath,
  parseSubmissionId,
  type CampaignLink,
  type SubmissionId,
} from "../../lib/campaign-link";
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

/** What `POST /world-id/request` returns: everything IDKit needs to open. */
interface WorldIdRequest {
  appId: `app_${string}` | null;
  action: string;
  environment: "production" | "staging";
  rpContext: RpContext;
}

type Step =
  | { kind: "verify" }
  | { kind: "answer" }
  | { kind: "rejected"; code: string }
  | { kind: "claim"; submissionId: SubmissionId }
  | { kind: "pending"; hash: Hash }
  | { kind: "paid"; hash: Hash | null };

const WORLD_ID_MODE = process.env.NEXT_PUBLIC_WORLD_ID_MODE ?? "live";

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
  const [link, setLink] = useState<CampaignLink>({ kind: "none" });
  const campaignId = link.kind === "campaign" ? link.id : null;
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [eligibilityToken, setEligibilityToken] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>({ kind: "verify" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [worldRequest, setWorldRequest] = useState<WorldIdRequest | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);

  const key = (name: string) =>
    `vham:${campaignId}:${wallet?.address.toLowerCase()}:${name}`;

  useEffect(() => {
    const resolved = campaignLink(window.location.search);
    setLink(resolved);
    if (resolved.kind !== "campaign") return;
    const { id } = resolved;
    void (async () => {
      try {
        const [loadedCampaign, loadedMission] = await Promise.all([
          api<Campaign>(campaignPath(id)),
          api<Mission>(campaignPath(id, "/mission")),
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
      const prefix = `vham:${campaignId}:${connected.address.toLowerCase()}:`;
      const token = store<string>(`${prefix}eligibility`);
      const submissionId = parseSubmissionId(
        store<string>(`${prefix}submission`),
      );
      if (token) setEligibilityToken(token);
      if (submissionId) setStep({ kind: "claim", submissionId });
      else if (token) setStep({ kind: "answer" });
    });

  /** Sends the IDKit result, unchanged, with the wallet; never logs it. */
  async function verifyEligibility(
    claimant: Address,
    idkitResponse: unknown,
  ): Promise<void> {
    if (!campaignId) return;
    const { data } = await api<{ eligibilityToken: string }>(
      campaignPath(campaignId, "/eligibility/verify"),
      { method: "POST", body: { claimant, idkitResponse } },
    );
    store(key("eligibility"), data.eligibilityToken);
    setEligibilityToken(data.eligibilityToken);
  }

  const verifyHuman = () =>
    run(async () => {
      if (!wallet || !campaignId) return;
      if (WORLD_ID_MODE === "simulated") {
        // Local anvil demo only: the API refuses simulated proofs elsewhere.
        await verifyEligibility(wallet.address, {
          action: `vham-campaign-${campaignId}`,
          simulatedHuman: wallet.address.toLowerCase(),
        });
        setStep({ kind: "answer" });
        return;
      }
      // A fresh RP signature per attempt; the signing key stays on the API.
      const { data } = await api<WorldIdRequest>(
        campaignPath(campaignId, "/world-id/request"),
        { method: "POST" },
      );
      if (!data.appId) throw new Error("World ID is not configured.");
      setWorldRequest(data);
      setWidgetOpen(true);
    });

  /** Throwing here makes the widget show its error state (host rejected). */
  async function handleWorldIdVerify(result: IDKitResult) {
    if (!wallet) throw new Error("Connect your wallet first.");
    try {
      await verifyEligibility(wallet.address, result);
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
      }>(campaignPath(campaignId, "/submissions"), {
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
        const submissionId = parseSubmissionId(data.submissionId);
        if (!submissionId) {
          throw new Error("The API returned an invalid submission id.");
        }
        store(key("submission"), submissionId);
        setStep({ kind: "claim", submissionId });
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
        claimAuthorizationPath(campaignId, step.submissionId),
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
        <p className="error">
          {link.kind === "invalid"
            ? "This campaign link is not valid. Ask for a fresh link."
            : "Missing ?campaign=<id> in the link."}
        </p>
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
          <button onClick={verifyHuman} disabled={busy || !active}>
            {WORLD_ID_MODE === "simulated"
              ? "Verify (local simulation)"
              : "Verify with World ID"}
          </button>
        </section>
      )}

      {worldRequest?.appId && (
        <IDKitRequestWidget
          open={widgetOpen}
          onOpenChange={setWidgetOpen}
          app_id={worldRequest.appId}
          action={worldRequest.action}
          rp_context={worldRequest.rpContext}
          environment={worldRequest.environment}
          allow_legacy_proofs={false}
          preset={proofOfHuman()}
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
