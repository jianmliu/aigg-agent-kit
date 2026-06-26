/**
 * attestation-verifier — the AI-verifiability leg of the execution layer.
 *
 * The STF is deterministic (fraud-proof). The AI is not — so its output is
 * committed as a signed `Attestation` (model + promptHash + responseHash + sig).
 * This module VERIFIES that attestation, turning "trust the operator" into
 * "verify the proof". Near-term the signature is an operator ECDSA sig (we can
 * do this today); the SAME interface accepts a TEE remote-attestation quote as a
 * drop-in (hardware root-of-trust) once inference runs in a TEE.
 *
 * End-to-end (`verifyTalkProvenance`): an `applyTalk` tx's effects ARE the
 * deterministic parse of an attested model response — so anyone can check that
 * ai.gg didn't fabricate effects the model never produced. It proves
 * authenticity (a genuine model run), NOT AI "correctness" (no such notion) —
 * which is exactly the anti-forgery property the game needs.
 */
import { createHash } from 'node:crypto';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAgentIntent } from '@aigg/npc-agent';
import type { Attestation, Effect } from '@aigg/npc-agent';

export const sha256Hex = (s: string): string => '0x' + createHash('sha256').update(s, 'utf8').digest('hex');

/** the canonical message an attestation signs over (model | promptHash | responseHash). */
export const attestationMessage = (a: { model: string; promptHash: string; responseHash: string }): string =>
  `${a.model}|${a.promptHash}|${a.responseHash}`;

export interface VerifyResult { ok: boolean; signer?: string; reason?: string }

export interface AttestationVerifier {
  verify(att: Attestation): Promise<VerifyResult>;
}

/**
 * Near-term verifier: operator ECDSA signature recovered + checked against an
 * allowlist of signer addresses. Swap for a TEE quote verifier (same interface)
 * when inference moves into a TEE.
 */
export class OperatorAttestationVerifier implements AttestationVerifier {
  private readonly allowed: Set<string>;
  constructor(allowedSigners: string[]) { this.allowed = new Set(allowedSigners.map((a) => a.toLowerCase())); }

  async verify(att: Attestation): Promise<VerifyResult> {
    if (!att.signature) return { ok: false, reason: 'no_signature' };
    try {
      const signer = (await recoverMessageAddress({ message: attestationMessage(att), signature: att.signature as Hex })).toLowerCase();
      if (!this.allowed.has(signer)) return { ok: false, signer, reason: 'signer_not_allowed' };
      return { ok: true, signer };
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
  }
}

/** Producer (tests / ai.gg gateway near-term): operator-sign an attestation. */
export async function signAttestation(opts: { model: string; prompt: string; response: string; signerKey: Hex; now?: number }): Promise<Attestation> {
  const promptHash = sha256Hex(opts.prompt);
  const responseHash = sha256Hex(opts.response);
  const account = privateKeyToAccount(opts.signerKey);
  const signature = await account.signMessage({ message: attestationMessage({ model: opts.model, promptHash, responseHash }) });
  return { model: opts.model, promptHash, responseHash, signature, signedAt: opts.now ?? 0 };
}

export interface TalkProvenance {
  attestation: Attestation;
  /** the raw model response text (posted to DA so a challenger can re-derive). */
  response: string;
  /** the effects committed in the applyTalk tx (must equal parseAgentIntent(response).effects). */
  effects: Effect[];
}

/**
 * Full chain: (1) attestation valid + signer allowed, (2) sha256(response) ==
 * responseHash, (3) deterministic parse of the response yields exactly the
 * committed effects. If all hold, the AI-driven state transition is authentic
 * and re-derivable — a challenger can dispute any step.
 */
export async function verifyTalkProvenance(p: TalkProvenance, verifier: AttestationVerifier): Promise<VerifyResult> {
  const v = await verifier.verify(p.attestation);
  if (!v.ok) return v;
  if (sha256Hex(p.response) !== p.attestation.responseHash) return { ok: false, signer: v.signer, reason: 'response_hash_mismatch' };
  const parsed = parseAgentIntent(p.response);
  const parsedEffects = parsed.ok && parsed.intent?.effects ? parsed.intent.effects : [];
  if (JSON.stringify(parsedEffects) !== JSON.stringify(p.effects)) return { ok: false, signer: v.signer, reason: 'effects_mismatch' };
  return { ok: true, signer: v.signer };
}
