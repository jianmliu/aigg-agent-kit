/**
 * inference-oracle — the AI boundary for the deterministic world STF.
 *
 * The STF (world-stf.ts) is pure + reproducible; the NON-deterministic LLM
 * reasoning is quarantined HERE, behind an oracle interface. An InferenceOracle
 * takes a talk context and produces the EFFECTS (say + relationship/flag deltas
 * + GCC cost), optionally with an `Attestation` (the provider's signed hash of
 * prompt+response+model). That output becomes the input data of a deterministic
 * `applyTalk` tx; the STF only applies it. A fraud proof then checks the STF
 * applied the (signed) effects correctly — it never re-runs the LLM.
 *
 * LlmInferenceOracle WRAPS the existing LlmAgent (so the prompt / metabolism /
 * parse are byte-identical to the in-place SharedWorld reasoning), and captures
 * the raw InferenceResult (usage + attestation) via a provider proxy.
 */
import { LlmAgent, RelationshipMemory, InMemoryStore } from '@onchainpal/npc-agent';
import type {
  Effect, NpcPersona, RelationshipState, Attestation, InferenceProvider, InferenceResult,
  InferenceUsage, Metabolism, Perception,
} from '@onchainpal/npc-agent';

export interface OracleInput {
  npcId: string;
  playerId: string;
  text: string;
  persona: NpcPersona;
  /** the NPC's GCC balance (gates thinking via metabolism). null = unknown. */
  balanceGcc: number | null;
  /** the current per-visitor relationship (seeds the prompt context). */
  rel: RelationshipState;
}

export interface OracleOutput {
  say: string | null;
  effects: Effect[];
  /** GCC this turn's thinking cost (becomes the applyTalk burn). */
  gccCost: number;
  /** full metering of the inference (for settlement). */
  usage?: InferenceUsage;
  emotion?: string;
  /** provider signature over prompt+response+model — the committable provenance. */
  attestation?: Attestation;
}

export interface InferenceOracle {
  produce(input: OracleInput): Promise<OracleOutput>;
}

export interface LlmInferenceOracleOptions {
  provider: InferenceProvider;
  /** optional cognitive metabolism — starving NPCs return a scripted line, no LLM, no GCC. */
  metabolism?: Metabolism;
  /** line spoken when starving. */
  hungerLine?: string;
  temperature?: number;
}

export class LlmInferenceOracle implements InferenceOracle {
  constructor(private readonly o: LlmInferenceOracleOptions) {}

  async produce(input: OracleInput): Promise<OracleOutput> {
    // capture the raw InferenceResult (usage + attestation) via a proxy provider.
    let captured: InferenceResult | undefined;
    const base = this.o.provider;
    const proxy: InferenceProvider = { id: base.id, complete: async (req) => { const r = await base.complete(req); captured = r; return r; } };

    // seed a one-shot in-memory relationship so LlmAgent's prompt sees input.rel
    // (affinity + tags) — reuses RelationshipMemory's exact key/shape.
    const store = new InMemoryStore();
    const rels = new RelationshipMemory(store);
    if (input.rel.affinity || input.rel.tags.length) {
      await rels.applyDelta(input.persona.id, input.playerId, input.rel.affinity, input.rel.tags, input.rel.lastInteractionAt ?? 0);
    }

    const agent = new LlmAgent({
      persona: input.persona, provider: proxy, relationships: rels,
      metabolism: this.o.metabolism, readBalanceGcc: async () => input.balanceGcc,
      hungerLine: this.o.hungerLine, temperature: this.o.temperature,
    });
    const intent = await agent.perceive({ kind: 'interaction', npcId: input.persona.id, playerId: input.playerId, text: input.text } as Perception);

    return {
      say: intent?.say?.trim() ? intent.say.trim() : null,
      effects: intent?.effects ?? [],
      gccCost: captured?.usage?.gccCost ?? 0,
      usage: captured?.usage,
      emotion: intent?.emotion,
      attestation: captured?.attestation,
    };
  }
}
