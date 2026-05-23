// Snap bot poster — sends a CMO-approved draft to a Telegram chat
// via the standard Bot API. Bot token + channel map come from the
// 1Claw vault so credentials never sit on disk.
//
// Vault layout (under your default vault id):
//   telegram/snap-bot-token   — the raw `123456:ABC...` Telegram bot token
//   telegram/channels         — JSON map of channel slug → chat_id,
//                               e.g. `{"builders":-1002345678901,"public":-1009876543210}`
//
// Override either source via env if you need to test against a sandbox:
//   SNAP_BOT_TOKEN
//   SNAP_CHANNEL_MAP_JSON

const TELEGRAM_API = "https://api.telegram.org";

// Lazy-loaded so tests that inject deps.getSecret never trigger the
// real @1claw/sdk import (which pulls in vault config + network deps).
async function defaultGetSecret(path: string): Promise<string> {
  const mod = await import("../../mcp/tools.js");
  return mod.getSecret(path);
}

const VAULT_PATH_TOKEN = "telegram/snap-bot-token";
const VAULT_PATH_CHANNELS = "telegram/channels";

/**
 * Injectable dependencies for the Snap poster. Production callers can
 * leave these alone — defaults read from the real vault + use global
 * fetch. Tests can swap them out without ESM mock gymnastics.
 */
export interface SnapDeps {
  getSecret?: (path: string) => Promise<string>;
  fetch?: typeof fetch;
}

export type SnapParseMode =
  | "MarkdownV2"
  | "Markdown"
  | "HTML"
  | "none";

export interface SnapPostInput {
  channel: string;
  text: string;
  /** Default: MarkdownV2 — strictest, safest for unstructured text. */
  parseMode?: SnapParseMode;
  /** When true, return the request body but don't send. Default true. */
  dryRun?: boolean;
  /** Disable link previews (default true — release notes look noisy with them). */
  disablePreview?: boolean;
}

export interface SnapPostResult {
  dryRun: boolean;
  url: string;
  body: Record<string, unknown>;
  /** Only present when dryRun=false and the API responded. */
  response?: { ok: boolean; result?: unknown; description?: string };
}

interface ChannelMap {
  [slug: string]: number | string;
}

async function loadToken(deps: SnapDeps): Promise<string> {
  const envToken = process.env.SNAP_BOT_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const getter = deps.getSecret ?? defaultGetSecret;
  return getter(VAULT_PATH_TOKEN);
}

async function loadChannels(deps: SnapDeps): Promise<ChannelMap> {
  const envMap = process.env.SNAP_CHANNEL_MAP_JSON;
  const getter = deps.getSecret ?? defaultGetSecret;
  const raw = envMap && envMap.trim()
    ? envMap.trim()
    : await getter(VAULT_PATH_CHANNELS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Snap channel map at ${VAULT_PATH_CHANNELS} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Snap channel map must be a JSON object of slug → chat_id; got ${typeof parsed}`,
    );
  }
  return parsed as ChannelMap;
}

/** Resolves a channel slug to a Telegram chat_id from the vault map. */
export async function resolveChannel(
  slug: string,
  deps: SnapDeps = {},
): Promise<number | string> {
  const map = await loadChannels(deps);
  if (!(slug in map)) {
    const known = Object.keys(map).join(", ") || "(empty)";
    throw new Error(
      `Unknown Snap channel "${slug}". Known channels: ${known}.`,
    );
  }
  return map[slug];
}

/**
 * Send (or stage) a draft to a Snap-controlled Telegram chat.
 *
 * Defaults are conservative: `dryRun: true` and `parseMode: "MarkdownV2"`.
 * Pass `dryRun: false` to actually fire the request.
 */
export async function postToSnap(
  input: SnapPostInput,
  deps: SnapDeps = {},
): Promise<SnapPostResult> {
  const parseMode = input.parseMode ?? "MarkdownV2";
  const dryRun = input.dryRun ?? true;
  const disablePreview = input.disablePreview ?? true;

  const chatId = await resolveChannel(input.channel, deps);
  const token = await loadToken(deps);

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: input.text,
    disable_web_page_preview: disablePreview,
  };
  if (parseMode !== "none") body.parse_mode = parseMode;

  // Mask the token everywhere we surface a URL — never let it leak
  // through logs or the returned object, even on success.
  const masked = url.replace(/bot[^/]+/, "bot<TOKEN>");

  if (dryRun) return { dryRun: true, url: masked, body };

  const fetcher = deps.fetch ?? globalThis.fetch;
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => ({}));
  return {
    dryRun: false,
    url: masked,
    body,
    response: json as SnapPostResult["response"],
  };
}

/**
 * Convert a CMO draft written with common Markdown (`**bold**`, single
 * backticks) into Telegram's MarkdownV2 escaping rules so the post
 * actually renders. Inline code spans are left untouched.
 *
 * Telegram MarkdownV2 reserved chars that must be escaped outside of
 * code blocks: `_*[]()~`>#+-=|{}.!`
 *
 * This is intentionally narrow — it handles the formatting our CMO
 * outputs (Telegram bullets, paths, bold). For anything fancier,
 * pre-format the draft yourself and pass `parseMode: "HTML"`.
 */
export function toMarkdownV2(input: string): string {
  // Split on backticks so we can leave code spans untouched.
  const parts = input.split(/(`[^`]*`)/);
  const escaped = parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return part;
    // **bold** → *bold* (Telegram MarkdownV2 syntax for bold).
    let s = part.replace(/\*\*([^*]+)\*\*/g, "*$1*");
    // Escape every MarkdownV2 reserved char NOT inside a bold span.
    // We do this in two passes: escape outside *...*, then re-emit.
    s = s.replace(/(\*[^*]+\*)|([_\[\]()~>#+\-=|{}.!\\])/g, (_m, bold, ch) =>
      bold ? bold : `\\${ch}`,
    );
    return s;
  });
  return escaped.join("");
}
