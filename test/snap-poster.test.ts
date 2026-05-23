import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postToSnap,
  resolveChannel,
  toMarkdownV2,
  type SnapDeps,
} from "../src/talents/cmo/snap-poster.js";

const STUB_TOKEN = "123456:TEST_TOKEN";
const STUB_CHANNELS = JSON.stringify({
  builders: -1002345678901,
  public: -1009876543210,
});

function stubDeps(overrides: Partial<SnapDeps> = {}): SnapDeps {
  return {
    getSecret: async (path: string) => {
      if (path === "telegram/snap-bot-token") return STUB_TOKEN;
      if (path === "telegram/channels") return STUB_CHANNELS;
      throw new Error(`Unexpected vault read: ${path}`);
    },
    ...overrides,
  };
}

describe("resolveChannel", () => {
  beforeEach(() => {
    delete process.env.SNAP_CHANNEL_MAP_JSON;
  });

  it("returns the chat_id for a known slug from the vault", async () => {
    const id = await resolveChannel("builders", stubDeps());
    expect(id).toBe(-1002345678901);
  });

  it("throws a helpful error for an unknown slug", async () => {
    await expect(resolveChannel("nope", stubDeps())).rejects.toThrow(
      /Unknown Snap channel "nope".*builders/,
    );
  });

  it("prefers SNAP_CHANNEL_MAP_JSON env override when set", async () => {
    process.env.SNAP_CHANNEL_MAP_JSON = JSON.stringify({
      builders: -1099999999999,
    });
    const id = await resolveChannel("builders", stubDeps());
    expect(id).toBe(-1099999999999);
  });

  it("rejects a malformed channel map blob from the vault", async () => {
    await expect(
      resolveChannel("builders", {
        getSecret: async () => "this is not json",
      }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("postToSnap (dry run)", () => {
  beforeEach(() => {
    delete process.env.SNAP_CHANNEL_MAP_JSON;
    delete process.env.SNAP_BOT_TOKEN;
  });

  it("defaults to dry run with MarkdownV2 + no preview, masks the token", async () => {
    const result = await postToSnap(
      { channel: "builders", text: "*hello* builders" },
      stubDeps(),
    );
    expect(result.dryRun).toBe(true);
    expect(result.url).toContain("bot<TOKEN>");
    expect(result.url).not.toContain("TEST_TOKEN");
    expect(result.body).toEqual({
      chat_id: -1002345678901,
      text: "*hello* builders",
      disable_web_page_preview: true,
      parse_mode: "MarkdownV2",
    });
    expect(result.response).toBeUndefined();
  });

  it("omits parse_mode when explicitly disabled", async () => {
    const result = await postToSnap(
      { channel: "builders", text: "plain", parseMode: "none" },
      stubDeps(),
    );
    expect(result.body.parse_mode).toBeUndefined();
  });

  it("honors disablePreview override", async () => {
    const result = await postToSnap(
      { channel: "builders", text: "x", disablePreview: false },
      stubDeps(),
    );
    expect(result.body.disable_web_page_preview).toBe(false);
  });
});

describe("postToSnap (live)", () => {
  beforeEach(() => {
    delete process.env.SNAP_CHANNEL_MAP_JSON;
    delete process.env.SNAP_BOT_TOKEN;
  });

  it("POSTs to the correct Telegram endpoint with the resolved chat_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await postToSnap(
      { channel: "builders", text: "release notes", dryRun: false },
      stubDeps({ fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.telegram.org/bot123456:TEST_TOKEN/sendMessage",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe(-1002345678901);
    expect(body.text).toBe("release notes");
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(result.response?.ok).toBe(true);
    // Even on a successful send, the returned URL must stay masked.
    expect(result.url).toContain("bot<TOKEN>");
    expect(result.url).not.toContain("TEST_TOKEN");
  });

  it("returns the failure payload when Telegram says not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: chat not found",
        }),
        { status: 400 },
      ),
    );
    const result = await postToSnap(
      { channel: "builders", text: "x", dryRun: false },
      stubDeps({ fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(result.response?.ok).toBe(false);
    expect(result.response?.description).toMatch(/chat not found/);
  });
});

describe("toMarkdownV2", () => {
  it("converts **bold** to *bold* (Telegram MarkdownV2 syntax)", () => {
    expect(toMarkdownV2("hello **world**")).toBe("hello *world*");
  });

  it("escapes reserved chars outside of bold + code spans", () => {
    const out = toMarkdownV2("v0.21.2 — keys (now) expire!");
    expect(out).toContain("v0\\.21\\.2");
    expect(out).toContain("\\(now\\)");
    expect(out).toContain("expire\\!");
  });

  it("leaves backticked code spans untouched", () => {
    const out = toMarkdownV2("call `POST /v1/foo.bar` then");
    expect(out).toContain("`POST /v1/foo.bar`");
  });

  it("escapes outside code but preserves inside", () => {
    const out = toMarkdownV2("see `a.b` and c.d");
    expect(out).toContain("`a.b`");
    expect(out).toContain("c\\.d");
  });
});
