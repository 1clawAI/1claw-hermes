import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  toHermesRequest,
  flattenContent,
  buildCompletionResponse,
  buildChunk,
  sseData,
  SSE_DONE,
  startAdapter,
  type StartedAdapter,
} from "../src/adapter/openai-sse-adapter.js";
import {
  SubprocessHermesDriver,
  type HermesDriver,
  type HermesGenerateRequest,
  type HermesGenerateResult,
  type HermesStreamEvent,
  type SpawnLike,
} from "../src/adapter/hermes-driver.js";
import {
  resolveAdapterEnv,
  ADAPTER_DEFAULT_PORT,
  ADAPTER_DEFAULT_HOST,
} from "../src/adapter/serve.js";

// ---------------------------------------------------------------------------
// Test doubles for the HermesDriver seam (no real process ever spawned).
// ---------------------------------------------------------------------------

class MockDriver implements HermesDriver {
  public lastRequest: HermesGenerateRequest | null = null;
  constructor(
    private readonly opts: {
      deltas?: string[];
      finishReason?: string;
      generateResult?: HermesGenerateResult;
      throwAt?: "start" | "mid";
      throwError?: Error;
    } = {},
  ) {}

  async generate(req: HermesGenerateRequest): Promise<HermesGenerateResult> {
    this.lastRequest = req;
    if (this.opts.throwAt) {
      throw this.opts.throwError ?? new Error("generate failed");
    }
    return (
      this.opts.generateResult ?? {
        content: (this.opts.deltas ?? []).join(""),
        finishReason: this.opts.finishReason ?? "stop",
      }
    );
  }

  async *stream(req: HermesGenerateRequest): AsyncIterable<HermesStreamEvent> {
    this.lastRequest = req;
    if (this.opts.throwAt === "start") {
      throw this.opts.throwError ?? new Error("stream failed immediately");
    }
    const deltas = this.opts.deltas ?? [];
    for (let i = 0; i < deltas.length; i++) {
      yield { type: "delta", text: deltas[i] };
      if (this.opts.throwAt === "mid" && i === 0) {
        throw this.opts.throwError ?? new Error("stream failed mid-way");
      }
    }
    yield { type: "done", finishReason: this.opts.finishReason ?? "stop" };
  }
}

async function withAdapter(
  driver: HermesDriver,
  token: string | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const started: StartedAdapter = await startAdapter({ driver, token, port: 0 });
  try {
    await fn(started.url);
  } finally {
    await started.close();
  }
}

function parseSseChunks(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => block.slice("data:".length).trim())
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

// ---------------------------------------------------------------------------
// Pure translation helpers.
// ---------------------------------------------------------------------------

describe("flattenContent", () => {
  it("returns string content unchanged", () => {
    expect(flattenContent("hello")).toBe("hello");
  });
  it("joins multimodal text parts and ignores non-text", () => {
    expect(
      flattenContent([
        { type: "text", text: "a" },
        { type: "image_url" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });
  it("treats null/undefined as empty", () => {
    expect(flattenContent(null)).toBe("");
    expect(flattenContent(undefined)).toBe("");
  });
});

describe("toHermesRequest", () => {
  it("translates messages, model, temperature and max_tokens", () => {
    const req = toHermesRequest({
      model: "claude-opus-4.6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.3,
      max_tokens: 128,
    });
    expect(req.model).toBe("claude-opus-4.6");
    expect(req.temperature).toBe(0.3);
    expect(req.maxTokens).toBe(128);
    expect(req.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("derives shroudProvider from the model id (reuses providerForModel)", () => {
    expect(toHermesRequest({ model: "gpt-4o", messages: [] }).shroudProvider).toBe(
      "openai",
    );
    expect(
      toHermesRequest({ model: "gemini-2.5-flash", messages: [] }).shroudProvider,
    ).toBe("google");
    expect(
      toHermesRequest({ model: "some-unknown", messages: [] }).shroudProvider,
    ).toBeUndefined();
  });

  it("normalises a string stop into an array and drops empties", () => {
    expect(toHermesRequest({ messages: [], stop: "STOP" }).stop).toEqual(["STOP"]);
    expect(toHermesRequest({ messages: [], stop: ["a", ""] }).stop).toEqual(["a"]);
    expect(toHermesRequest({ messages: [] }).stop).toBeUndefined();
  });

  it("captures unmodelled OpenAI fields under passthrough", () => {
    const req = toHermesRequest({
      messages: [],
      top_p: 0.9,
      user: "abc",
    } as never);
    expect(req.passthrough).toEqual({ top_p: 0.9, user: "abc" });
  });

  it("flattens multimodal message content", () => {
    const req = toHermesRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] },
      ],
    });
    expect(req.messages[0].content).toBe("xy");
  });
});

describe("buildCompletionResponse / buildChunk / sse framing", () => {
  it("builds a chat.completion with a single assistant choice", () => {
    const res = buildCompletionResponse({
      id: "id1",
      created: 100,
      model: "hermes",
      content: "hello",
      finishReason: "stop",
    });
    expect(res.object).toBe("chat.completion");
    const choices = res.choices as Array<Record<string, unknown>>;
    expect((choices[0].message as Record<string, unknown>).content).toBe("hello");
    expect(choices[0].finish_reason).toBe("stop");
    expect(res.usage).toBeUndefined();
  });

  it("includes usage when provided", () => {
    const res = buildCompletionResponse({
      id: "id1",
      created: 1,
      model: "m",
      content: "",
      usage: { promptTokens: 3, completionTokens: 4 },
    });
    expect(res.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
  });

  it("builds a chat.completion.chunk with a null finish_reason by default", () => {
    const chunk = buildChunk({
      id: "id",
      created: 1,
      model: "m",
      delta: { content: "x" },
    });
    expect(chunk.object).toBe("chat.completion.chunk");
    const choices = chunk.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBeNull();
    expect(choices[0].delta).toEqual({ content: "x" });
  });

  it("frames SSE data lines and exposes the [DONE] terminator", () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});

// ---------------------------------------------------------------------------
// HTTP: non-streaming.
// ---------------------------------------------------------------------------

describe("adapter — non-streaming", () => {
  it("returns a translated chat.completion", async () => {
    const driver = new MockDriver({
      generateResult: { content: "the answer", finishReason: "stop" },
    });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "q" }],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.object).toBe("chat.completion");
      expect(json.model).toBe("claude-opus-4.6");
      const choices = json.choices as Array<Record<string, unknown>>;
      expect((choices[0].message as Record<string, unknown>).content).toBe(
        "the answer",
      );
      // Provider was derived and threaded to the driver.
      expect(driver.lastRequest?.shroudProvider).toBe("anthropic");
    });
  });

  it("echoes the default model when the request omits one", async () => {
    const driver = new MockDriver({ generateResult: { content: "" } });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.model).toBe("hermes");
    });
  });

  it("returns 502 with an OpenAI-style error when the driver throws", async () => {
    const driver = new MockDriver({
      throwAt: "start",
      throwError: new Error("hermes boom"),
    });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { message: string; type: string } };
      expect(json.error.message).toBe("hermes boom");
      expect(json.error.type).toBe("hermes_error");
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP: streaming SSE.
// ---------------------------------------------------------------------------

describe("adapter — streaming SSE", () => {
  it("streams role priming, content deltas, a final finish_reason and [DONE]", async () => {
    const driver = new MockDriver({ deltas: ["Hel", "lo!"], finishReason: "stop" });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text.endsWith(SSE_DONE)).toBe(true);

      const chunks = parseSseChunks(text) as Array<Record<string, unknown>>;
      // role prime + 2 content deltas + final finish chunk.
      expect(chunks.length).toBe(4);
      const firstDelta = (chunks[0].choices as Array<Record<string, unknown>>)[0]
        .delta as Record<string, unknown>;
      expect(firstDelta.role).toBe("assistant");

      const content = chunks
        .map((c) => (c.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>)
        .map((d) => (typeof d.content === "string" ? d.content : ""))
        .join("");
      expect(content).toBe("Hello!");

      const last = chunks[chunks.length - 1];
      expect((last.choices as Array<Record<string, unknown>>)[0].finish_reason).toBe(
        "stop",
      );
    });
  });

  it("returns 502 (not a half-open stream) when the driver throws before the first delta", async () => {
    const driver = new MockDriver({
      throwAt: "start",
      throwError: new Error("immediate stream failure"),
    });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe("immediate stream failure");
    });
  });

  it("emits an error event and no [DONE] when the driver throws mid-stream", async () => {
    const driver = new MockDriver({
      deltas: ["partial"],
      throwAt: "mid",
      throwError: new Error("mid failure"),
    });
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.includes("[DONE]")).toBe(false);
      expect(text).toContain('"error"');
      expect(text).toContain("mid failure");
    });
  });
});

// ---------------------------------------------------------------------------
// Auth, routing and body validation.
// ---------------------------------------------------------------------------

describe("adapter — auth & routing", () => {
  it("rejects requests without the bearer token when auth is configured", async () => {
    const driver = new MockDriver({ generateResult: { content: "x" } });
    await withAdapter(driver, "s3cr3t", async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: { type: string } };
      expect(json.error.type).toBe("invalid_request_error");
    });
  });

  it("accepts requests with the correct bearer token", async () => {
    const driver = new MockDriver({ generateResult: { content: "ok" } });
    await withAdapter(driver, "s3cr3t", async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer s3cr3t",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(200);
    });
  });

  it("serves GET /healthz", async () => {
    const driver = new MockDriver();
    await withAdapter(driver, undefined, async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toEqual({ status: "ok" });
    });
  });

  it("404s unknown routes and 405s wrong methods", async () => {
    const driver = new MockDriver();
    await withAdapter(driver, undefined, async (base) => {
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/v1/chat/completions`)).status).toBe(405);
    });
  });

  it("400s an invalid JSON body and a missing messages array", async () => {
    const driver = new MockDriver();
    await withAdapter(driver, undefined, async (base) => {
      const bad = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);

      const noMessages = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
      expect(noMessages.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// serve.ts env resolution.
// ---------------------------------------------------------------------------

describe("resolveAdapterEnv", () => {
  it("falls back to sane defaults", () => {
    const cfg = resolveAdapterEnv({});
    expect(cfg.port).toBe(ADAPTER_DEFAULT_PORT);
    expect(cfg.host).toBe(ADAPTER_DEFAULT_HOST);
    expect(cfg.token).toBeUndefined();
  });

  it("reads port, host, token, model and CLI overrides from env", () => {
    const cfg = resolveAdapterEnv({
      ONECLAW_HERMES_NATIVE_PORT: "9001",
      ONECLAW_HERMES_NATIVE_HOST: "127.0.0.2",
      ONECLAW_HERMES_NATIVE_TOKEN: "tok",
      ONECLAW_HERMES_NATIVE_MODEL: "hermes-3",
      ONECLAW_HERMES_CLI: "hermes-wrapper",
      ONECLAW_HERMES_CLI_ARGS: '["chat","--json"]',
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(9001);
    expect(cfg.host).toBe("127.0.0.2");
    expect(cfg.token).toBe("tok");
    expect(cfg.defaultModel).toBe("hermes-3");
    expect(cfg.command).toBe("hermes-wrapper");
    expect(cfg.args).toEqual(["chat", "--json"]);
  });

  it("ignores an out-of-range port and malformed CLI args", () => {
    const cfg = resolveAdapterEnv({
      ONECLAW_HERMES_NATIVE_PORT: "99999",
      ONECLAW_HERMES_CLI_ARGS: "{bad",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(ADAPTER_DEFAULT_PORT);
    expect(cfg.args).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SubprocessHermesDriver — with an injected fake spawn (no real process).
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => boolean;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("SubprocessHermesDriver (injected spawn)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams stdout chunks as deltas then a done event", async () => {
    const child = makeFakeChild();
    const spawnImpl: SpawnLike = vi.fn(() => child as never);
    const driver = new SubprocessHermesDriver({ spawnImpl });

    const events: HermesStreamEvent[] = [];
    const collect = (async () => {
      for await (const ev of driver.stream({ messages: [{ role: "user", content: "hi" }] })) {
        events.push(ev);
      }
    })();

    // Emit stdout across ticks, then close cleanly.
    await new Promise((r) => setImmediate(r));
    child.stdout.write("Hel");
    await new Promise((r) => setImmediate(r));
    child.stdout.write("lo");
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await collect;

    const deltas = events.filter((e) => e.type === "delta") as Array<{ text: string }>;
    expect(deltas.map((d) => d.text).join("")).toBe("Hello");
    expect(events[events.length - 1]).toEqual({ type: "done", finishReason: "stop" });
  });

  it("accumulates the full text for a non-streaming generate()", async () => {
    const child = makeFakeChild();
    const spawnImpl: SpawnLike = vi.fn(() => child as never);
    const driver = new SubprocessHermesDriver({ spawnImpl });

    const p = driver.generate({ messages: [{ role: "user", content: "hi" }] });
    await new Promise((r) => setImmediate(r));
    child.stdout.write("answer ");
    child.stdout.write("text");
    child.emit("close", 0);
    const result = await p;
    expect(result.content).toBe("answer text");
    expect(result.finishReason).toBe("stop");
  });

  it("throws when the child exits non-zero, surfacing stderr", async () => {
    const child = makeFakeChild();
    const spawnImpl: SpawnLike = vi.fn(() => child as never);
    const driver = new SubprocessHermesDriver({ spawnImpl });

    const p = (async () => {
      for await (const _ of driver.stream({ messages: [] })) {
        // drain
      }
    })();
    await new Promise((r) => setImmediate(r));
    child.stderr.write("model unavailable");
    child.emit("close", 3);
    await expect(p).rejects.toThrow(/code 3.*model unavailable/);
  });

  it("threads shroudProvider into the child env and prompt onto stdin", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const child = makeFakeChild();
    const stdinChunks: string[] = [];
    child.stdin.on("data", (c: Buffer) => stdinChunks.push(c.toString("utf-8")));
    const spawnImpl: SpawnLike = vi.fn((_cmd, _args, options) => {
      capturedEnv = options.env;
      return child as never;
    });
    const driver = new SubprocessHermesDriver({ spawnImpl });

    const p = driver.generate({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-opus-4.6",
      shroudProvider: "anthropic",
    });
    await new Promise((r) => setImmediate(r));
    child.stdout.write("ok");
    child.emit("close", 0);
    await p;

    expect(capturedEnv?.X_SHROUD_PROVIDER).toBe("anthropic");
    expect(capturedEnv?.SHROUD_PROVIDER).toBe("anthropic");
    expect(stdinChunks.join("")).toContain('"role":"user"');
  });
});
