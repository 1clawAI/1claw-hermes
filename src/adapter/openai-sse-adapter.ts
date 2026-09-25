import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { providerForModel } from "../mcp/hermes-config.js";
import type {
  HermesDriver,
  HermesGenerateRequest,
  HermesChatMessage,
} from "./hermes-driver.js";

/**
 * OpenAI-compatible SSE chat adapter for Hermes.
 *
 * Exposes `POST /v1/chat/completions` (plus `GET /healthz`) on a loopback port
 * and translates OpenAI Chat Completions requests to/from the {@link HermesDriver}
 * seam, streaming responses back in standard OpenAI SSE shape
 * (`chat.completion.chunk` deltas, terminated by `data: [DONE]`).
 *
 * Wiring (owned by the sibling `packages/runtime-base` worker — NOT set here):
 *   - Path:  POST /v1/chat/completions   (health: GET /healthz)
 *   - Host:  ONECLAW_HERMES_NATIVE_HOST   (default 127.0.0.1 — loopback only)
 *   - Port:  ONECLAW_HERMES_NATIVE_PORT   (default 8778)
 *   - Auth:  ONECLAW_HERMES_NATIVE_TOKEN  (optional; when set, requests must send
 *            `Authorization: Bearer <token>`)
 * The generic "proxy-to-native" resolver in
 * `packages/runtime-base/templates/shared/native-agent-server.js` points at
 * `http://ONECLAW_HERMES_NATIVE_HOST:ONECLAW_HERMES_NATIVE_PORT/v1`.
 */

// ---------------------------------------------------------------------------
// OpenAI wire types (minimal — only what we read/emit).
// ---------------------------------------------------------------------------

type OpenAiContentPart = { type?: string; text?: string };

export interface OpenAiChatMessage {
  role: string;
  content: string | null | OpenAiContentPart[];
  name?: string;
}

export interface OpenAiChatCompletionRequest {
  model?: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

const DEFAULT_MODEL = "hermes";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const HEALTH_PATH = "/healthz";

/** Flatten OpenAI message content (string or multimodal parts) to plain text. */
export function flattenContent(
  content: string | null | OpenAiContentPart[] | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part?.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

function normaliseStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop == null) return undefined;
  const arr = Array.isArray(stop) ? stop : [stop];
  const filtered = arr.filter((s) => typeof s === "string" && s.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Translate an OpenAI Chat Completions request into the provider-neutral
 * {@link HermesGenerateRequest} the driver consumes. Pure and exported for tests.
 */
export function toHermesRequest(
  body: OpenAiChatCompletionRequest,
): HermesGenerateRequest {
  const messages: HermesChatMessage[] = (body.messages ?? []).map((m) => ({
    role: typeof m.role === "string" ? m.role : "user",
    content: flattenContent(m.content),
    ...(m.name ? { name: m.name } : {}),
  }));

  const {
    messages: _m,
    model: _model,
    stream: _s,
    temperature: _t,
    max_tokens: _mt,
    stop: _stop,
    ...passthrough
  } = body;

  return {
    messages,
    model: body.model,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    stop: normaliseStop(body.stop),
    // Reuse providerForModel() so a Shroud-backed Hermes keeps its
    // X-Shroud-Provider behaviour (threaded to the driver, see hermes-driver.ts).
    shroudProvider: providerForModel(body.model),
    passthrough: Object.keys(passthrough).length > 0 ? passthrough : undefined,
  };
}

/** Generate an OpenAI-style completion id. */
export function newCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

/** Build a non-streaming `chat.completion` response object. Pure; exported for tests. */
export function buildCompletionResponse(params: {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}): Record<string, unknown> {
  const usage = params.usage
    ? {
        prompt_tokens: params.usage.promptTokens ?? 0,
        completion_tokens: params.usage.completionTokens ?? 0,
        total_tokens:
          params.usage.totalTokens ??
          (params.usage.promptTokens ?? 0) +
            (params.usage.completionTokens ?? 0),
      }
    : undefined;

  return {
    id: params.id,
    object: "chat.completion",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        finish_reason: params.finishReason ?? "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** Build a streaming `chat.completion.chunk` object. Pure; exported for tests. */
export function buildChunk(params: {
  id: string;
  created: number;
  model: string;
  delta: { role?: string; content?: string };
  finishReason?: string | null;
}): Record<string, unknown> {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };
}

/** Frame a JSON object as a single SSE `data:` event. */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** The SSE stream terminator OpenAI clients wait for. */
export const SSE_DONE = "data: [DONE]\n\n";

function errorBody(message: string, type = "adapter_error"): Record<string, unknown> {
  return { error: { message, type } };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  /** The Hermes driver seam. Required. */
  driver: HermesDriver;
  /** Bearer token required on requests. When unset, no auth is enforced. */
  token?: string;
  /** Bind host. Defaults to 127.0.0.1 (loopback). */
  host?: string;
  /** Default model name echoed back when the request omits one. */
  defaultModel?: string;
}

function isAuthorized(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const expected = `Bearer ${token}`;
  // Loopback-only surface; a plain compare is sufficient.
  return header === expected;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleChatCompletion(
  body: OpenAiChatCompletionRequest,
  res: http.ServerResponse,
  opts: AdapterOptions,
): Promise<void> {
  const model = typeof body.model === "string" && body.model
    ? body.model
    : opts.defaultModel ?? DEFAULT_MODEL;
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const hermesReq = toHermesRequest(body);

  if (body.stream) {
    await streamChatCompletion(hermesReq, res, opts, { id, created, model });
    return;
  }

  // Non-streaming: collect the full result, then translate.
  try {
    const result = await opts.driver.generate(hermesReq);
    sendJson(
      res,
      200,
      buildCompletionResponse({
        id,
        created,
        model,
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      }),
    );
  } catch (err) {
    sendJson(
      res,
      502,
      errorBody(err instanceof Error ? err.message : String(err), "hermes_error"),
    );
  }
}

async function streamChatCompletion(
  hermesReq: HermesGenerateRequest,
  res: http.ServerResponse,
  opts: AdapterOptions,
  meta: { id: string; created: number; model: string },
): Promise<void> {
  const iterator = opts.driver.stream(hermesReq)[Symbol.asyncIterator]();

  // Peek the first event *before* committing to SSE headers so an immediate
  // driver failure surfaces as a clean HTTP JSON error (not a half-open stream).
  let first: IteratorResult<{ type: "delta"; text: string } | { type: "done"; finishReason?: string }>;
  try {
    first = await iterator.next();
  } catch (err) {
    sendJson(
      res,
      502,
      errorBody(err instanceof Error ? err.message : String(err), "hermes_error"),
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  // Role-priming chunk first, matching OpenAI's stream shape.
  res.write(
    sseData(
      buildChunk({ ...meta, delta: { role: "assistant", content: "" }, finishReason: null }),
    ),
  );

  let finishReason = "stop";
  try {
    let current = first;
    while (!current.done) {
      const event = current.value;
      if (event.type === "delta") {
        if (event.text.length > 0) {
          res.write(
            sseData(buildChunk({ ...meta, delta: { content: event.text }, finishReason: null })),
          );
        }
      } else {
        finishReason = event.finishReason ?? "stop";
      }
      current = await iterator.next();
    }
  } catch (err) {
    // Mid-stream failure: emit an error event, then end without [DONE].
    res.write(
      sseData(errorBody(err instanceof Error ? err.message : String(err), "hermes_error")),
    );
    res.end();
    return;
  }

  // Final chunk carries the finish_reason, then the [DONE] terminator.
  res.write(sseData(buildChunk({ ...meta, delta: {}, finishReason })));
  res.write(SSE_DONE);
  res.end();
}

/** Route a single request. Exported so tests can drive it without a live socket if desired. */
export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AdapterOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];

  if (method === "GET" && pathname === HEALTH_PATH) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (pathname !== CHAT_COMPLETIONS_PATH) {
    sendJson(res, 404, errorBody(`Unknown route ${method} ${pathname}`, "not_found"));
    return;
  }

  if (method !== "POST") {
    sendJson(res, 405, errorBody("Method not allowed", "method_not_allowed"));
    return;
  }

  if (!isAuthorized(req, opts.token)) {
    sendJson(res, 401, errorBody("Unauthorized", "invalid_request_error"));
    return;
  }

  let body: OpenAiChatCompletionRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as OpenAiChatCompletionRequest;
  } catch {
    sendJson(res, 400, errorBody("Invalid JSON body", "invalid_request_error"));
    return;
  }

  if (!body || !Array.isArray(body.messages)) {
    sendJson(res, 400, errorBody("`messages` array is required", "invalid_request_error"));
    return;
  }

  await handleChatCompletion(body, res, opts);
}

/**
 * Create (but do not start) the adapter HTTP server. Call `.listen(port, host)`
 * — or use {@link startAdapter} — to bind it.
 */
export function createAdapterServer(opts: AdapterOptions): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
      if (!res.headersSent) {
        sendJson(
          res,
          500,
          errorBody(err instanceof Error ? err.message : String(err), "internal_error"),
        );
      } else {
        res.end();
      }
    });
  });
}

export interface StartedAdapter {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Create and bind the adapter server on the given (loopback) host/port. */
export function startAdapter(
  opts: AdapterOptions & { port: number },
): Promise<StartedAdapter> {
  const host = opts.host ?? "127.0.0.1";
  const server = createAdapterServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : opts.port;
      resolve({
        server,
        host,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
