// X (Twitter) poster — posts a thread of tweets from a 1Claw-controlled
// X account using OAuth 1.0a credentials from the vault. Mirrors the
// shape of snap-poster.ts: dependency injection for tests, dryRun
// default, env overrides for sandbox testing.
//
// Vault layout (single JSON blob under your default vault id):
//   x/1clawai-oauth1   — JSON with shape:
//                        { "apiKey": "...", "apiSecret": "...",
//                          "accessToken": "...", "accessTokenSecret": "..." }
//
// Override individual fields via env vars (handy for sandbox accounts):
//   X_API_KEY              X_API_SECRET
//   X_ACCESS_TOKEN         X_ACCESS_TOKEN_SECRET
// or the whole blob:
//   X_OAUTH1_JSON          (full JSON string, same shape as the vault)

import { readFile } from "node:fs/promises";

const VAULT_PATH_OAUTH1 = "x/1clawai-oauth1";

// Lazy-loaded so tests that inject deps.getSecret never trigger the
// real @1claw/sdk import (which pulls in vault config + network deps).
async function defaultGetSecret(path: string): Promise<string> {
  const mod = await import("../../mcp/tools.js");
  return mod.getSecret(path);
}

export interface XOAuth1Creds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** Minimal surface our code uses against an X client. Lets us swap in a
 *  fake for tests without depending on the full TwitterApi shape. */
export interface QuoteTweet {
  /** Numeric tweet id of the quote-tweet itself (the builder's post). */
  id: string;
  /** Text body of the quote-tweet. */
  text: string;
  /** @handle without the leading @, e.g. "somebuilder". */
  authorHandle: string;
  /** Numeric user id of the quote-tweet's author. */
  authorId: string;
  /** ISO 8601 created_at timestamp. */
  createdAt: string;
  /** Canonical x.com URL of the quote-tweet. */
  url: string;
}

export interface XClientLike {
  uploadMedia(input: { filePath?: string; buffer?: Buffer; mimeType?: string }): Promise<string>;
  tweet(input: { text: string; mediaIds?: string[]; replyToId?: string }): Promise<{ id: string; url: string }>;
  /** List quote-tweets of an anchor tweet. Optional sinceId restricts
   *  results to tweets newer than the given id (X API pagination). */
  listQuoteTweets(anchorId: string, opts?: { sinceId?: string; max?: number }): Promise<QuoteTweet[]>;
}

export interface XDeps {
  /** Vault read. Default reads from the 1claw-mcp vault. */
  getSecret?: (path: string) => Promise<string>;
  /** Build a real X client. Default wraps twitter-api-v2. Tests pass a fake. */
  buildClient?: (creds: XOAuth1Creds) => XClientLike;
}

export interface XTweetInput {
  /** Body of the tweet. Required. ≤280 chars (we do not enforce — X will). */
  text: string;
  /** Absolute paths to local media files to attach. Up to 4 per tweet. */
  media?: string[];
  /** Optional. When set, this tweet replies to the given X tweet id
   *  INSTEAD OF chaining to the previous tweet in the thread array.
   *  Use this to boost a builder's quote-tweet — set replyTo to the
   *  quote-tweet's numeric id and the reply lands under their post. */
  replyTo?: string;
}

export interface XThreadInput {
  /** Ordered list of tweets. First tweet is the anchor; subsequent
   *  tweets reply to the previous one to form a thread. */
  tweets: XTweetInput[];
  /** When true, return what would be sent without firing. Default true. */
  dryRun?: boolean;
}

export interface XPostedTweet {
  index: number;
  id: string;
  url: string;
  text: string;
  mediaCount: number;
  replyToId: string | null;
}

export interface XThreadResult {
  dryRun: boolean;
  account: string;          // best-effort identifier (handle if known)
  tweets: XPostedTweet[];   // populated on real send; dry-run gets placeholders
}

async function loadCreds(deps: XDeps): Promise<XOAuth1Creds> {
  // Env-blob overrides everything (sandbox / CI).
  const blob = process.env.X_OAUTH1_JSON;
  if (blob && blob.trim()) {
    return parseCredsBlob(blob, "X_OAUTH1_JSON");
  }
  // Individual env overrides — useful when you want to swap just the
  // access token (e.g. test from a side-account) without re-vaulting.
  const ek = process.env.X_API_KEY;
  const es = process.env.X_API_SECRET;
  const et = process.env.X_ACCESS_TOKEN;
  const eS = process.env.X_ACCESS_TOKEN_SECRET;
  if (ek && es && et && eS) {
    return { apiKey: ek, apiSecret: es, accessToken: et, accessTokenSecret: eS };
  }
  const getter = deps.getSecret ?? defaultGetSecret;
  const raw = await getter(VAULT_PATH_OAUTH1);
  return parseCredsBlob(raw, VAULT_PATH_OAUTH1);
}

function parseCredsBlob(raw: string, source: string): XOAuth1Creds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `X OAuth1 creds at ${source} are not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `X OAuth1 creds at ${source} must be a JSON object; got ${typeof parsed}`,
    );
  }
  const o = parsed as Record<string, unknown>;
  const required = ["apiKey", "apiSecret", "accessToken", "accessTokenSecret"] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) {
      throw new Error(
        `X OAuth1 creds at ${source} missing required field "${k}".`,
      );
    }
  }
  return {
    apiKey: o.apiKey as string,
    apiSecret: o.apiSecret as string,
    accessToken: o.accessToken as string,
    accessTokenSecret: o.accessTokenSecret as string,
  };
}

// Default client factory: wraps twitter-api-v2. Lazy-imported so the
// runtime cost (and any transient resolution issues) doesn't hit
// tests that pass their own buildClient.
async function defaultBuildClient(creds: XOAuth1Creds): Promise<XClientLike> {
  const { TwitterApi } = await import("twitter-api-v2");
  const api = new TwitterApi({
    appKey: creds.apiKey,
    appSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });
  return {
    async uploadMedia(input) {
      // v1.1 chunked upload — works with OAuth 1.0a creds. Accepts a
      // file path OR a buffer + mimeType.
      if (input.filePath) {
        const buf = await readFile(input.filePath);
        const mime = input.mimeType ?? guessMime(input.filePath);
        return api.v1.uploadMedia(buf, { mimeType: mime });
      }
      if (input.buffer) {
        return api.v1.uploadMedia(input.buffer, {
          mimeType: input.mimeType ?? "image/png",
        });
      }
      throw new Error("uploadMedia: must pass filePath or buffer.");
    },
    async tweet(input) {
      const body: Record<string, unknown> = { text: input.text };
      if (input.mediaIds && input.mediaIds.length > 0) {
        body.media = { media_ids: input.mediaIds };
      }
      if (input.replyToId) {
        body.reply = { in_reply_to_tweet_id: input.replyToId };
      }
      const res = await api.v2.tweet(body as Parameters<typeof api.v2.tweet>[0]);
      const id = res.data.id;
      return {
        id,
        // URL shape uses a placeholder for the handle — X redirects from
        // /i/web/status/<id> to the canonical /<handle>/status/<id>.
        url: `https://x.com/i/web/status/${id}`,
      };
    },
    async listQuoteTweets(anchorId, opts) {
      // GET /2/tweets/:id/quote_tweets — returns tweets that quote the
      // anchor. Twitter-api-v2 returns a paginator object; we unwrap
      // through `unknown` because the paginator's internal type isn't
      // stable across minor versions but the underlying response shape is.
      const result = await api.v2.quotes(anchorId, {
        expansions: ["author_id"],
        "tweet.fields": ["created_at", "author_id"],
        "user.fields": ["username"],
        since_id: opts?.sinceId,
        max_results: Math.min(opts?.max ?? 100, 100),
      } as Parameters<typeof api.v2.quotes>[1]);
      const raw = result as unknown as {
        // Paginator exposes both `tweets` (the array accessor) and the
        // raw `data`/`includes`. Fall through both for resilience.
        tweets?: { id: string; text: string; author_id?: string; created_at?: string }[];
        data?: { id: string; text: string; author_id?: string; created_at?: string }[];
        includes?: { users?: { id: string; username: string }[] };
      };
      const tweets = raw.tweets ?? raw.data ?? [];
      const usersById = new Map<string, string>();
      for (const u of raw.includes?.users ?? []) usersById.set(u.id, u.username);
      return tweets.map((t) => {
        const handle = (t.author_id && usersById.get(t.author_id)) || "unknown";
        return {
          id: t.id,
          text: t.text,
          authorHandle: handle,
          authorId: t.author_id ?? "",
          createdAt: t.created_at ?? "",
          url: `https://x.com/${handle}/status/${t.id}`,
        };
      });
    },
  };
}

function guessMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

/**
 * Post a single tweet or a connected thread to X.
 *
 * Defaults: dryRun=true (returns the planned payloads without sending).
 * Pass dryRun=false to actually fire. Each tweet after the first replies
 * to the previous tweet's id, forming a thread under the anchor.
 */
export async function postThread(
  input: XThreadInput,
  deps: XDeps = {},
): Promise<XThreadResult> {
  if (!input.tweets || input.tweets.length === 0) {
    throw new Error("postThread: tweets array is empty.");
  }
  const dryRun = input.dryRun ?? true;

  // Validate media file paths up-front so dry-run catches typos too.
  for (let i = 0; i < input.tweets.length; i++) {
    const t = input.tweets[i];
    if (!t.text || !t.text.trim()) {
      throw new Error(`postThread: tweet[${i}] has empty text.`);
    }
    if (t.media && t.media.length > 4) {
      throw new Error(`postThread: tweet[${i}] has >4 media (X limit).`);
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      account: "<dry-run — not authenticated>",
      tweets: input.tweets.map((t, i) => ({
        index: i,
        id: `<dry-run-${i}>`,
        url: `<dry-run-${i}>`,
        text: t.text,
        mediaCount: t.media?.length ?? 0,
        // External replyTo wins over the auto-chain. First tweet with no
        // replyTo and no previous-in-thread has null replyToId.
        replyToId: t.replyTo ?? (i === 0 ? null : `<dry-run-${i - 1}>`),
      })),
    };
  }

  const creds = await loadCreds(deps);
  const client = deps.buildClient
    ? deps.buildClient(creds)
    : await defaultBuildClient(creds);

  const posted: XPostedTweet[] = [];
  let prevId: string | null = null;
  for (let i = 0; i < input.tweets.length; i++) {
    const t = input.tweets[i];
    let mediaIds: string[] = [];
    if (t.media && t.media.length > 0) {
      for (const mp of t.media) {
        mediaIds.push(await client.uploadMedia({ filePath: mp }));
      }
    }
    // External replyTo wins over the auto-chain. Lets us reply to a
    // builder's quote-tweet (which is not part of this thread) and still
    // chain follow-ups under our own reply.
    const effectiveReplyTo = t.replyTo ?? prevId ?? undefined;
    const result = await client.tweet({
      text: t.text,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      replyToId: effectiveReplyTo,
    });
    posted.push({
      index: i,
      id: result.id,
      url: result.url,
      text: t.text,
      mediaCount: mediaIds.length,
      replyToId: effectiveReplyTo ?? null,
    });
    prevId = result.id;
  }

  return {
    dryRun: false,
    // Best-effort label — we don't round-trip through GET /users/me to
    // save an API call; the caller already knows which account they're
    // posting from based on which creds they vaulted.
    account: "@1clawai",
    tweets: posted,
  };
}

export interface FetchQuoteTweetsOptions {
  /** Only fetch quote-tweets newer than this tweet id. Useful for
   *  resumable boost-mode runs — pass the highest id you already
   *  reviewed. */
  sinceId?: string;
  /** Maximum number of quote-tweets to return. Default 100 (X API cap
   *  per page). Pagination across pages is NOT handled here — we
   *  expect boost-mode to sweep a single page at a time. */
  max?: number;
}

/**
 * List the quote-tweets of a given anchor tweet. Read-only — does not
 * touch tweets or send anything. Useful for boost-mode workflows where
 * the operator wants to sweep recent quote-tweets and reply to each.
 */
export async function fetchQuoteTweets(
  anchorId: string,
  opts: FetchQuoteTweetsOptions = {},
  deps: XDeps = {},
): Promise<QuoteTweet[]> {
  if (!anchorId || !/^\d+$/.test(anchorId)) {
    throw new Error(
      `fetchQuoteTweets: anchorId must be a numeric tweet id, got ${JSON.stringify(anchorId)}.`,
    );
  }
  const creds = await loadCreds(deps);
  const client = deps.buildClient
    ? deps.buildClient(creds)
    : await defaultBuildClient(creds);
  return client.listQuoteTweets(anchorId, {
    sinceId: opts.sinceId,
    max: opts.max,
  });
}
