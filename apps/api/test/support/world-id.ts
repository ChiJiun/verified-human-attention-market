import type {
  WorldIdResult,
  WorldIdVerifier,
} from "../../src/identity/world-id.js";

/**
 * Accepts `{ action, human }` as the IDKit result when the action matches;
 * the human string is the nullifier. Tests of the verification itself use
 * their own fake (eligibility.test.ts).
 */
export class FakeWorldId implements WorldIdVerifier {
  async verify(request: {
    action: string;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    const proof = request.idkitResponse as { action: string; human: string };
    return proof.action === request.action
      ? { ok: true, nullifier: proof.human }
      : { ok: false, code: "ACTION_MISMATCH" };
  }
}
