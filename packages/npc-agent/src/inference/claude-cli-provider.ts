import { spawn } from 'node:child_process';
import type { InferenceProvider, InferenceRequest, InferenceResult } from './provider';

export interface ClaudeCliProviderOptions {
  /** model alias/id passed to `--model` (e.g. "haiku"). Omit = claude's default. */
  model?: string;
  /** the CLI command (default "claude"). */
  cmd?: string;
  /** GCC cost = (inputTok/1e6)*gccPerMInput + (outputTok/1e6)*gccPerMOutput. */
  pricing?: { gccPerMInput: number; gccPerMOutput: number };
  timeoutMs?: number;
  /** injectable runner (default = spawn `claude`); tests pass a fake to assert args. */
  run?: (args: string[], stdin: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * ClaudeCliProvider — inference via headless `claude -p`, reusing the user's
 * Claude Code login (subscription, no API key). Backend-equivalent to the
 * aigg-memory kernel's claude-cli transport.
 *
 * ⚠️ The load-bearing detail (learned the hard way in aigg-memory's E1-real):
 * `claude -p` is **agentic Claude Code, not a bare completion endpoint**. Its
 * default persona replies CONVERSATIONALLY and ignores an in-band "return only
 * JSON" instruction — so the NPC's structured-effect prompt fails to parse. The
 * fix is to OVERRIDE the system prompt, not append:
 *   `--system-prompt <extractor>`  (full override, beats the agentic persona)
 *   `--exclude-dynamic-system-prompt-sections`  (drop CLAUDE.md / env context)
 * → `claude -p` becomes a clean structured extractor. We never use
 * `--append-system-prompt` (which loses to the persona).
 */
export class ClaudeCliProvider implements InferenceProvider {
  readonly id = 'claude-cli';
  private readonly o: Required<Pick<ClaudeCliProviderOptions, 'cmd' | 'pricing' | 'timeoutMs'>> & ClaudeCliProviderOptions;
  private readonly run: NonNullable<ClaudeCliProviderOptions['run']>;

  constructor(opts: ClaudeCliProviderOptions = {}) {
    this.o = { cmd: opts.cmd ?? 'claude', pricing: opts.pricing ?? { gccPerMInput: 1, gccPerMOutput: 2 }, timeoutMs: opts.timeoutMs ?? 180_000, ...opts };
    this.run = opts.run ?? ((args, stdin, signal) => defaultRun(this.o.cmd, args, stdin, this.o.timeoutMs, signal));
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    // OVERRIDE the system prompt (never --append) + drop dynamic sections → clean extractor.
    const system = request.system ?? 'You output only the requested structured value. No prose, no markdown.';
    const args = ['-p', '--system-prompt', system, '--exclude-dynamic-system-prompt-sections'];
    if (this.o.model) args.push('--model', this.o.model);
    const stdout = await this.run(args, request.prompt, request.signal);
    const text = stdout.trim();
    const inputTokens = Math.ceil((request.prompt.length + system.length) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const gccCost = (inputTokens / 1e6) * this.o.pricing.gccPerMInput + (outputTokens / 1e6) * this.o.pricing.gccPerMOutput;
    return { text, usage: { model: this.o.model ?? 'claude-cli', inputTokens, outputTokens, gccCost } };
  }
}

function defaultRun(cmd: string, args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`[ClaudeCliProvider] timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`[ClaudeCliProvider] claude -p failed (rc=${code}): ${err.trim().slice(0, 300)}`)); });
    child.stdin.write(stdin); child.stdin.end();
  });
}
