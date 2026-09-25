import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * The `HermesDriver` seam.
 *
 * The OpenAI-compatible adapter ({@link ../adapter/openai-sse-adapter}) never
 * talks to Hermes directly. It translates an OpenAI `/v1/chat/completions`
 * request into a {@link HermesGenerateRequest}, hands it to a `HermesDriver`,
 * and translates the driver's output back into OpenAI response / SSE shapes.
 *
 * Hermes (Nous Research) is installed at image-build time and exposes **no
 * documented HTTP chat surface** — `hermes gateway` is launched by
 * `packages/runtime-base/templates/shared/hermes-agent-start.sh` as
 * `exec hermes gateway` (no `--port`). We therefore define the driver as an
 * interface so the *concrete* invocation (a subprocess/stdio call to the
 * `hermes` CLI today, a native HTTP surface tomorrow) can change without
 * touching the well-tested translation layer.
 *
 * Tests mock this seam; they never spawn a real process.
 */
export interface HermesDriver {
  /**
   * Non-streaming generation. Resolves the full assistant text once Hermes has
   * finished producing it.
   */
  generate(
    req: HermesGenerateRequest,
    signal?: AbortSignal,
  ): Promise<HermesGenerateResult>;

  /**
   * Streaming generation. Yields incremental deltas as Hermes produces them and
   * a terminal `done` event carrying the finish reason.
   */
  stream(
    req: HermesGenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<HermesStreamEvent>;
}

/** A single chat turn, normalised from the OpenAI request. */
export interface HermesChatMessage {
  role: string;
  content: string;
  name?: string;
}

/**
 * The provider-neutral request the adapter builds for the driver. Field names
 * are deliberately camelCase and decoupled from the OpenAI wire shape so the
 * seam is stable.
 */
export interface HermesGenerateRequest {
  messages: HermesChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /**
   * Upstream Shroud provider derived from the model id via `providerForModel()`
   * (e.g. `anthropic`, `openai`). A concrete driver that drives a Shroud-backed
   * Hermes should surface this to Hermes (e.g. as the `X-Shroud-Provider`
   * header / env the model config expects). `undefined` when it cannot be told.
   */
  shroudProvider?: string;
  /** Verbatim OpenAI request fields the adapter did not model, for a driver to use if useful. */
  passthrough?: Record<string, unknown>;
}

export interface HermesGenerateResult {
  /** Full assistant text. */
  content: string;
  /** OpenAI finish reason (`stop`, `length`, …). Defaults to `stop` when absent. */
  finishReason?: string;
  /** Optional token accounting, mirrored into the OpenAI `usage` block. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/** Streaming events: incremental text deltas followed by a terminal `done`. */
export type HermesStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finishReason?: string };

// ---------------------------------------------------------------------------
// Concrete driver: subprocess / stdio call to the `hermes` CLI.
// ---------------------------------------------------------------------------

/** Minimal shape of `node:child_process`'s `spawn` we depend on (injectable for tests). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdio?: ["pipe", "pipe", "pipe"];
  },
) => ChildProcess;

export interface SubprocessHermesDriverOptions {
  /** Executable to invoke (default: `hermes`). */
  command?: string;
  /**
   * Arguments. NOTE: Hermes exposes no documented one-shot chat command, so the
   * default here is a **placeholder** that must be tuned to the real CLI when
   * the concrete invocation is finalised. The adapter's translation contract
   * (stdin prompt in, text deltas out) is what is guaranteed and tested — the
   * exact argv is intentionally the soft part of this seam.
   */
  args?: string[];
  /** Extra env for the child (merged over `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Injectable spawn (default: `node:child_process` spawn). Tests pass a fake. */
  spawnImpl?: SpawnLike;
  /**
   * How to render the request onto the child's stdin. Default: a single JSON
   * line (`{"messages":[…],"model":…}`) — a plausible, driver-agnostic contract
   * a thin `hermes` wrapper can read. Override to match the real CLI.
   */
  renderStdin?: (req: HermesGenerateRequest) => string;
}

const DEFAULT_HERMES_COMMAND = "hermes";
// Placeholder — see SubprocessHermesDriverOptions.args.
const DEFAULT_HERMES_ARGS = ["run", "--json", "--stream"];

function defaultRenderStdin(req: HermesGenerateRequest): string {
  return `${JSON.stringify({
    messages: req.messages,
    model: req.model,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stop: req.stop,
  })}\n`;
}

/**
 * A concrete {@link HermesDriver} that shells out to the `hermes` CLI, writes
 * the request to stdin and treats stdout as the streamed assistant text.
 *
 * This is deliberately format-tolerant: it emits stdout chunks as text deltas
 * as they arrive (streaming) or accumulates them (non-streaming). The precise
 * `hermes` argv/output contract is the soft part of the seam (see
 * {@link SubprocessHermesDriverOptions.args}); the translation the adapter
 * performs around it is the hardened, tested part.
 *
 * The `spawnImpl` seam keeps this class fully unit-testable **without spawning
 * a real process** — tests inject a fake that returns a scripted child.
 */
export class SubprocessHermesDriver implements HermesDriver {
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: NodeJS.ProcessEnv;
  private readonly spawnImpl: SpawnLike;
  private readonly renderStdin: (req: HermesGenerateRequest) => string;

  constructor(options: SubprocessHermesDriverOptions = {}) {
    this.command = options.command ?? DEFAULT_HERMES_COMMAND;
    this.args = options.args ?? [...DEFAULT_HERMES_ARGS];
    this.env = options.env;
    this.spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
    this.renderStdin = options.renderStdin ?? defaultRenderStdin;
  }

  private childEnv(req: HermesGenerateRequest): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    // Preserve X-Shroud-Provider behaviour: when the model resolves to a Shroud
    // upstream, hand the provider to the child so a Shroud-backed Hermes can set
    // the header Shroud requires. Non-invasive: only set when derivable.
    if (req.shroudProvider) {
      env.X_SHROUD_PROVIDER = req.shroudProvider;
      env.SHROUD_PROVIDER = req.shroudProvider;
    }
    return env;
  }

  private spawnChild(req: HermesGenerateRequest): ChildProcess {
    const child = this.spawnImpl(this.command, this.args, {
      env: this.childEnv(req),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdin) {
      child.stdin.write(this.renderStdin(req));
      child.stdin.end();
    }
    return child;
  }

  async generate(
    req: HermesGenerateRequest,
    signal?: AbortSignal,
  ): Promise<HermesGenerateResult> {
    let content = "";
    let finishReason: string | undefined;
    for await (const event of this.stream(req, signal)) {
      if (event.type === "delta") content += event.text;
      else finishReason = event.finishReason;
    }
    return { content, finishReason: finishReason ?? "stop" };
  }

  async *stream(
    req: HermesGenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<HermesStreamEvent> {
    const child = this.spawnChild(req);
    const onAbort = () => child.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) child.kill("SIGTERM");
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    let ended = false;
    let error: Error | null = null;
    let stderrBuf = "";

    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.length > 0) queue.push(chunk);
      wake();
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", (err: Error) => {
      error = err;
      ended = true;
      wake();
    });
    child.on("close", (code: number | null) => {
      if (code && code !== 0 && !error) {
        error = new Error(
          `hermes exited with code ${code}${
            stderrBuf ? `: ${stderrBuf.trim()}` : ""
          }`,
        );
      }
      ended = true;
      wake();
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const text = queue.shift() as string;
          yield { type: "delta", text };
        }
        if (error) throw error;
        if (ended) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      // Flush anything that arrived alongside close.
      while (queue.length > 0) {
        yield { type: "delta", text: queue.shift() as string };
      }
      if (error) throw error;
      yield { type: "done", finishReason: "stop" };
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
