/** Decision read out of memory (mirrors aigg-memory's discernment result). */
export interface Discernment { q: number; faculty: number; social: number; confidence: number }

/** A structured fact written via the kernel. Fields are routed into the kernel's payload. */
export interface RememberInput {
  slug: string;
  description: string;
  match: string[];                       // recall terms — MUST include the topic for text-mode discernment
  kind?: 'episodic' | 'semantic' | 'belief';
  assertedBy?: string;                   // provenance: corpusId(self) | corpusId(peer)
  outcome?: 'loss' | 'gain' | 'neutral';
  predicts?: string;
}

export interface SelectUnit { slug: string; description: string; kind: string }
export interface SelectResult { units: SelectUnit[]; bundle: string; total: number }

export interface DiscernOpts { mode?: 'text' | 'provenance'; marker?: string; minConfidence?: number; talent?: number; selfId?: string }

export interface CognitiveSignal {
  discernment: Discernment;
  trust: number;                         // self's trust in this peer
  beliefs: SelectResult;
  summary: string;                       // host-injectable prompt text
}

export interface EpisodeInput {
  topic: string;
  description: string;
  outcome: 'loss' | 'gain' | 'neutral';
  formBelief?: boolean;                  // default: true when outcome === 'loss'
}
