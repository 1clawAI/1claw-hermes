import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postThread,
  fetchQuoteTweets,
  type XClientLike,
  type XDeps,
  type XOAuth1Creds,
  type QuoteTweet,
} from "../src/talents/cmo/x-poster.js";

const STUB_CREDS_JSON = JSON.stringify({
  apiKey: "AAAA",
  apiSecret: "BBBB",
  accessToken: "CCCC",
  accessTokenSecret: "DDDD",
});

function stubDeps(overrides: Partial<XDeps> = {}): XDeps {
  return {
    getSecret: async (path: string) => {
      if (path === "x/1clawai-oauth1") return STUB_CREDS_JSON;
      throw new Error(`Unexpected vault read: ${path}`);
    },
    ...overrides,
  };
}

/** Tracks every call against a fake X client so tests can assert exact
 *  payloads and ordering. */
function makeRecordingClient(quoteTweets: QuoteTweet[] = []) {
  const uploads: Array<{ filePath?: string; buffer?: Buffer; mimeType?: string }> = [];
  const tweets: Array<{ text: string; mediaIds?: string[]; replyToId?: string }> = [];
  const quoteCalls: Array<{ anchorId: string; sinceId?: string; max?: number }> = [];
  let tweetCounter = 0;
  let mediaCounter = 0;
  const client: XClientLike = {
    async uploadMedia(input) {
      uploads.push(input);
      mediaCounter++;
      return `media-${mediaCounter}`;
    },
    async tweet(input) {
      tweets.push(input);
      tweetCounter++;
      const id = `tweet-${tweetCounter}`;
      return { id, url: `https://x.com/i/web/status/${id}` };
    },
    async listQuoteTweets(anchorId, opts) {
      quoteCalls.push({ anchorId, sinceId: opts?.sinceId, max: opts?.max });
      return quoteTweets;
    },
  };
  return { client, uploads, tweets, quoteCalls };
}

describe("postThread (dry run)", () => {
  beforeEach(() => {
    delete process.env.X_OAUTH1_JSON;
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
  });

  it("defaults to dry run and never touches the X client", async () => {
    const buildClient = vi.fn();
    const result = await postThread(
      { tweets: [{ text: "hello world" }] },
      stubDeps({ buildClient }),
    );
    expect(result.dryRun).toBe(true);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets[0].text).toBe("hello world");
    expect(result.tweets[0].id).toMatch(/^<dry-run-/);
    expect(buildClient).not.toHaveBeenCalled();
  });

  it("reports planned media counts and reply chain in dry run", async () => {
    const result = await postThread(
      {
        tweets: [
          { text: "anchor", media: ["/tmp/a.png", "/tmp/b.png"] },
          { text: "reply 1" },
          { text: "reply 2", media: ["/tmp/c.jpg"] },
        ],
      },
      stubDeps(),
    );
    expect(result.tweets).toHaveLength(3);
    expect(result.tweets[0].mediaCount).toBe(2);
    expect(result.tweets[0].replyToId).toBeNull();
    expect(result.tweets[1].mediaCount).toBe(0);
    expect(result.tweets[1].replyToId).toBe("<dry-run-0>");
    expect(result.tweets[2].mediaCount).toBe(1);
    expect(result.tweets[2].replyToId).toBe("<dry-run-1>");
  });

  it("rejects an empty tweets array", async () => {
    await expect(postThread({ tweets: [] }, stubDeps())).rejects.toThrow(
      /tweets array is empty/,
    );
  });

  it("rejects a tweet with empty text", async () => {
    await expect(
      postThread({ tweets: [{ text: "  " }] }, stubDeps()),
    ).rejects.toThrow(/empty text/);
  });

  it("rejects a tweet with >4 media files (X limit)", async () => {
    await expect(
      postThread(
        { tweets: [{ text: "ok", media: ["a", "b", "c", "d", "e"] }] },
        stubDeps(),
      ),
    ).rejects.toThrow(/>4 media/);
  });

  it("reflects an external replyTo in dry-run output (boost-reply use case)", async () => {
    const result = await postThread(
      {
        tweets: [
          { text: "✊ @builder shipping cool stuff", replyTo: "1234567890" },
        ],
      },
      stubDeps(),
    );
    // First tweet would normally have replyToId=null. With external
    // replyTo, the dry-run reports the external id instead so the user
    // can sanity-check before --send.
    expect(result.tweets[0].replyToId).toBe("1234567890");
  });

  it("external replyTo on first tweet, auto-chain on the rest", async () => {
    const result = await postThread(
      {
        tweets: [
          { text: "boost reply anchor", replyTo: "1234567890" },
          { text: "follow-up under our own reply" },
          { text: "another follow-up" },
        ],
      },
      stubDeps(),
    );
    expect(result.tweets[0].replyToId).toBe("1234567890");
    expect(result.tweets[1].replyToId).toBe("<dry-run-0>");
    expect(result.tweets[2].replyToId).toBe("<dry-run-1>");
  });
});

describe("postThread (live send)", () => {
  beforeEach(() => {
    delete process.env.X_OAUTH1_JSON;
  });

  it("posts a single tweet with media via the injected client", async () => {
    const { client, uploads, tweets } = makeRecordingClient();
    const result = await postThread(
      {
        dryRun: false,
        tweets: [{ text: "meet Snap. 🦞", media: ["/tmp/Snap.png"] }],
      },
      stubDeps({ buildClient: () => client }),
    );
    expect(uploads).toEqual([{ filePath: "/tmp/Snap.png" }]);
    expect(tweets).toHaveLength(1);
    expect(tweets[0]).toEqual({
      text: "meet Snap. 🦞",
      mediaIds: ["media-1"],
      replyToId: undefined,
    });
    expect(result.dryRun).toBe(false);
    expect(result.tweets[0].id).toBe("tweet-1");
    expect(result.tweets[0].url).toContain("/status/tweet-1");
  });

  it("chains tweets as replies under the anchor", async () => {
    const { client, tweets } = makeRecordingClient();
    const result = await postThread(
      {
        dryRun: false,
        tweets: [
          { text: "anchor" },
          { text: "reply 1" },
          { text: "reply 2" },
        ],
      },
      stubDeps({ buildClient: () => client }),
    );
    expect(tweets).toHaveLength(3);
    // First tweet has no replyToId; subsequent reply to the previous
    // tweet's returned id.
    expect(tweets[0].replyToId).toBeUndefined();
    expect(tweets[1].replyToId).toBe("tweet-1");
    expect(tweets[2].replyToId).toBe("tweet-2");
    expect(result.tweets.map((t) => t.id)).toEqual([
      "tweet-1",
      "tweet-2",
      "tweet-3",
    ]);
  });

  it("uses external replyTo to anchor a reply under a builder's quote-tweet", async () => {
    const { client, tweets } = makeRecordingClient();
    const result = await postThread(
      {
        dryRun: false,
        tweets: [
          { text: "✊ @builder shipping X", replyTo: "9999999999" },
        ],
      },
      stubDeps({ buildClient: () => client }),
    );
    // The single tweet posts as a reply to the EXTERNAL id, not as a
    // standalone tweet.
    expect(tweets).toHaveLength(1);
    expect(tweets[0].replyToId).toBe("9999999999");
    expect(result.tweets[0].replyToId).toBe("9999999999");
  });

  it("external replyTo anchors the thread; follow-ups chain under our reply", async () => {
    const { client, tweets } = makeRecordingClient();
    const result = await postThread(
      {
        dryRun: false,
        tweets: [
          { text: "boost reply", replyTo: "8888888888" },
          { text: "with a follow-up" },
        ],
      },
      stubDeps({ buildClient: () => client }),
    );
    // Tweet 1 replies to the external id; tweet 2 chains under tweet 1
    // (NOT the external id) so the follow-up sits under our boost,
    // not under the builder's original quote.
    expect(tweets[0].replyToId).toBe("8888888888");
    expect(tweets[1].replyToId).toBe("tweet-1");
    expect(result.tweets.map((t) => t.replyToId)).toEqual([
      "8888888888",
      "tweet-1",
    ]);
  });

  it("uploads multiple media before posting the tweet", async () => {
    const { client, uploads, tweets } = makeRecordingClient();
    await postThread(
      {
        dryRun: false,
        tweets: [
          { text: "two pics", media: ["/tmp/a.png", "/tmp/b.jpg"] },
        ],
      },
      stubDeps({ buildClient: () => client }),
    );
    expect(uploads).toEqual([
      { filePath: "/tmp/a.png" },
      { filePath: "/tmp/b.jpg" },
    ]);
    expect(tweets[0].mediaIds).toEqual(["media-1", "media-2"]);
  });

  it("reads creds from vault by default", async () => {
    const { client } = makeRecordingClient();
    const sawCreds: XOAuth1Creds[] = [];
    await postThread(
      { dryRun: false, tweets: [{ text: "x" }] },
      stubDeps({
        buildClient: (creds) => {
          sawCreds.push(creds);
          return client;
        },
      }),
    );
    expect(sawCreds).toHaveLength(1);
    expect(sawCreds[0]).toEqual({
      apiKey: "AAAA",
      apiSecret: "BBBB",
      accessToken: "CCCC",
      accessTokenSecret: "DDDD",
    });
  });

  it("prefers X_OAUTH1_JSON env override over the vault", async () => {
    process.env.X_OAUTH1_JSON = JSON.stringify({
      apiKey: "ENV_K",
      apiSecret: "ENV_S",
      accessToken: "ENV_T",
      accessTokenSecret: "ENV_TS",
    });
    const { client } = makeRecordingClient();
    const sawCreds: XOAuth1Creds[] = [];
    await postThread(
      { dryRun: false, tweets: [{ text: "x" }] },
      stubDeps({
        // getSecret should NOT be invoked when the env blob is set.
        getSecret: async () => {
          throw new Error("vault should not be read when env override set");
        },
        buildClient: (creds) => {
          sawCreds.push(creds);
          return client;
        },
      }),
    );
    expect(sawCreds[0].apiKey).toBe("ENV_K");
    expect(sawCreds[0].accessTokenSecret).toBe("ENV_TS");
  });

  it("prefers individual env vars when all four are set", async () => {
    process.env.X_API_KEY = "ek";
    process.env.X_API_SECRET = "es";
    process.env.X_ACCESS_TOKEN = "et";
    process.env.X_ACCESS_TOKEN_SECRET = "eS";
    const { client } = makeRecordingClient();
    const sawCreds: XOAuth1Creds[] = [];
    await postThread(
      { dryRun: false, tweets: [{ text: "x" }] },
      stubDeps({
        getSecret: async () => {
          throw new Error("vault should not be read when env override set");
        },
        buildClient: (creds) => {
          sawCreds.push(creds);
          return client;
        },
      }),
    );
    expect(sawCreds[0]).toEqual({
      apiKey: "ek",
      apiSecret: "es",
      accessToken: "et",
      accessTokenSecret: "eS",
    });
    // Cleanup so other tests don't inherit
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;
  });

  it("rejects a malformed creds blob with a helpful error", async () => {
    await expect(
      postThread(
        { dryRun: false, tweets: [{ text: "x" }] },
        { getSecret: async () => "not json" },
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a creds blob missing a required field", async () => {
    await expect(
      postThread(
        { dryRun: false, tweets: [{ text: "x" }] },
        {
          getSecret: async () =>
            JSON.stringify({ apiKey: "x", apiSecret: "y", accessToken: "z" }),
        },
      ),
    ).rejects.toThrow(/missing required field "accessTokenSecret"/);
  });
});

describe("fetchQuoteTweets", () => {
  beforeEach(() => {
    delete process.env.X_OAUTH1_JSON;
  });

  it("returns mapped QuoteTweet objects from the X client", async () => {
    const fakeQuotes: QuoteTweet[] = [
      {
        id: "111",
        text: "shipping a vault-native solana signer with @1clawai 🦞",
        authorHandle: "alice",
        authorId: "9001",
        createdAt: "2026-05-22T18:00:00.000Z",
        url: "https://x.com/alice/status/111",
      },
      {
        id: "222",
        text: "@1clawai is the right primitive for agent-shipped wallets",
        authorHandle: "bob",
        authorId: "9002",
        createdAt: "2026-05-22T19:00:00.000Z",
        url: "https://x.com/bob/status/222",
      },
    ];
    const { client, quoteCalls } = makeRecordingClient(fakeQuotes);
    const result = await fetchQuoteTweets(
      "1834567890123456789",
      {},
      stubDeps({ buildClient: () => client }),
    );
    expect(result).toEqual(fakeQuotes);
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0].anchorId).toBe("1834567890123456789");
  });

  it("returns [] when the anchor has no quote-tweets yet", async () => {
    const { client } = makeRecordingClient([]);
    const result = await fetchQuoteTweets(
      "1834567890123456789",
      {},
      stubDeps({ buildClient: () => client }),
    );
    expect(result).toEqual([]);
  });

  it("forwards sinceId + max to the underlying client (pagination + cap)", async () => {
    const { client, quoteCalls } = makeRecordingClient([]);
    await fetchQuoteTweets(
      "1834567890123456789",
      { sinceId: "9999000000000000000", max: 25 },
      stubDeps({ buildClient: () => client }),
    );
    expect(quoteCalls[0]).toEqual({
      anchorId: "1834567890123456789",
      sinceId: "9999000000000000000",
      max: 25,
    });
  });

  it("rejects a non-numeric anchorId", async () => {
    await expect(
      fetchQuoteTweets(
        "not-a-tweet-id",
        {},
        stubDeps({ buildClient: () => makeRecordingClient([]).client }),
      ),
    ).rejects.toThrow(/numeric tweet id/);
  });

  it("rejects an empty anchorId with a helpful error", async () => {
    await expect(
      fetchQuoteTweets(
        "",
        {},
        stubDeps({ buildClient: () => makeRecordingClient([]).client }),
      ),
    ).rejects.toThrow(/numeric tweet id/);
  });

  it("reads creds from the vault by default (single-call)", async () => {
    const { client } = makeRecordingClient([]);
    let credsLoaded = 0;
    await fetchQuoteTweets(
      "1834567890123456789",
      {},
      stubDeps({
        buildClient: (creds) => {
          credsLoaded++;
          expect(creds.apiKey).toBe("AAAA");
          return client;
        },
      }),
    );
    expect(credsLoaded).toBe(1);
  });
});
