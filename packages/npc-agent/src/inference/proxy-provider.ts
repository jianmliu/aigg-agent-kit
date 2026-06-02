import type { InferenceProvider, InferenceRequest, InferenceResult } from './provider';

export interface ProxyProviderOptions {
  /** base URL of the inference-proxy, e.g. https://node1.example/ or http://139.199.105.56:8090 */
  url: string;
  /** shared secret the proxy expects (x-proxy-secret). Keep out of source; inject at runtime. */
  secret?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * ProxyProvider — browser-safe InferenceProvider that calls the server-side
 * inference-proxy (which holds the ai.gg/sub2api token and burns GCC). The browser
 * never sees the upstream credential. Returns the proxy-metered usage (incl. gccCost).
 * Fetch-only — safe to bundle into the browser (unlike ClaudeProvider/SDK).
 */
export class ProxyProvider implements InferenceProvider {
  readonly id = 'proxy';
  private readonly url: string;
  private readonly secret?: string;
  private readonly model?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProxyProviderOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.secret = opts.secret;
    this.model = opts.model;
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) throw new Error('[ProxyProvider] no fetch implementation available');
    this.fetchImpl = f;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const res = await this.fetchImpl(`${this.url}/api/npc-infer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.secret ? { 'x-proxy-secret': this.secret } : {})
      },
      body: JSON.stringify({
        // npcId is set by the runtime via a per-NPC provider; default omitted here
        system: request.system,
        prompt: request.prompt,
        ...(this.model ? { model: this.model } : {})
      }),
      signal: request.signal
    });
    if (!res.ok) {
      throw new Error(`[ProxyProvider] ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
    }
    const json: any = await res.json();
    return { text: String(json.text ?? ''), usage: json.usage };
  }
}
