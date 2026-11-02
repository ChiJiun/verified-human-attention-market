"use client";

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
import { formatUnits, type Hash } from "viem";

import { api, describeError } from "../../lib/api";
import {
  campaignLink,
  campaignPath,
  claimAuthorizationPath,
  parseSubmissionId,
  type CampaignId,
  type CampaignLink,
  type SubmissionId,
} from "../../lib/campaign-link";
import {
  assertClaimChain,
  claimCall,
  isAlreadyPaid,
  simulateClaim,
  type Authorization,
} from "../../lib/claim";
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

interface LiveWorldIdRequest {
  mode: "live";
  appId: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  rpContext: RpContext;
}

type WorldIdRequest =
  LiveWorldIdRequest | { mode: "simulated"; action: string };

/** The proof signal's inputs, with the campaign id parsed from the link. */
type SignalBinding = WorldIdSignalInput & { campaignId: CampaignId };

interface PendingVerification {
  request: LiveWorldIdRequest;
  binding: SignalBinding;
}

type Step =
  | { kind: "verify" }
  | { kind: "answer" }
  | { kind: "rejected"; code: string }
  | { kind: "claim"; submissionId: SubmissionId }
  | { kind: "pending"; hash: Hash }
  | { kind: "paid"; hash: Hash }
  /** Paid earlier (another tab, an earlier visit); no transaction was sent. */
  | { kind: "already-paid" };

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
      // ALREADY_CLAIMED from the submission or the authorization (#82).
      if (isAlreadyPaid(caught)) setStep({ kind: "already-paid" });
      else setError(describeError(caught));
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
      const submissionId = parseSubmissionId(saved("submission"));
      if (token) setEligibilityToken(token);
      if (submissionId) setStep({ kind: "claim", submissionId });
      else if (token) setStep({ kind: "answer" });
    });

  async function verifyEligibility(
    binding: SignalBinding,
    idkitResponse: unknown,
  ): Promise<void> {
    const { data } = await api<{ eligibilityToken: string }>(
      campaignPath(binding.campaignId, "/eligibility/verify"),
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
      if (!wallet || !campaignId) return;
      // A fresh RP signature per attempt; the signing key stays on the API.
      const { data } = await api<WorldIdRequest>(
        campaignPath(campaignId, "/world-id/request"),
        { method: "POST" },
      );
      const binding: SignalBinding = {
        campaignId,
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
      // The simulation and the transaction go to the wallet's chain now.
      await assertClaimChain(wallet.walletClient, chain);
      // Re-requesting after expiry returns a fresh authorization; once the
      // wallet was paid the API answers ALREADY_CLAIMED instead.
      const { data: auth } = await api<Authorization>(
        claimAuthorizationPath(campaignId, step.submissionId),
        { method: "POST", body: { eligibilityToken } },
      );
      const call = claimCall(wallet.address, auth);
      // A claim the contract would refuse never reaches the wallet.
      if ((await simulateClaim(wallet.publicClient, call)) === "already-paid") {
        setStep({ kind: "already-paid" });
        return;
      }
      const hash = await wallet.walletClient.writeContract({ ...call, chain });
      setStep({ kind: "pending", hash });
      const outcome = await waitForTx(wallet.publicClient, hash);
      if (outcome.kind === "confirmed") {
        setStep({ kind: "paid", hash });
      } else if (outcome.kind === "reverted") {
        setStep({ kind: "claim", submissionId: step.submissionId });
        setError("The claim transaction reverted. You can request it again.");
      }
    }).catch(() => undefined);

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
          <p>
            <code>{step.hash}</code>
          </p>
        </section>
      )}

      {step.kind === "already-paid" && (
        <section className="card tx done" aria-live="polite">
          <strong>This reward was already paid to your wallet.</strong> No
          transaction was sent.
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
