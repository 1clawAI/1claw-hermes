#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { generateDrafts, type CmoPostFormat } from "./draft-generator.js";
import {
  postToSnap,
  resolveChannel,
  toMarkdownV2,
  type SnapParseMode,
} from "./snap-poster.js";
import { postThread, fetchQuoteTweets, type XThreadInput } from "./x-poster.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm cmo draft <topic> [--format <fmt>] [--candidates N] [--context <text>] [--model <id>]",
      "  pnpm cmo post  --channel <slug> (--message <text> | --file <path> | -)",
      "                 [--parse-mode markdown_v2|markdown|html|none]",
      "                 [--auto-format] [--send] [--allow-preview]",
      "  pnpm cmo channel <slug>           # resolve a channel slug to its chat_id",
      "  pnpm cmo x --thread <thread.json> [--send]",
      "                                    # post a single tweet or reply-chain to X",
      "  pnpm cmo quotes --anchor <id> [--since <id>] [--max <n>]",
      "                                    # list quote-tweets of an anchor (JSON to stdout)",
      "",
      "Draft formats (gitlawb playbook):",
      "  newsdrop          — ship → 1-line thesis",
      "  stats             — bare numbers + install command",
      "  qt                — 1-line QT hijack",
      "  qt-bigissue       — 3-paragraph DMCA-style QT",
      "  milestone         — \"N stars!\" hashtagged one-liner",
      "  release           — version + headline + reply-thread bullets",
      "  dogfood           — \"we shipped X using our own Y\"",
      "  poll              — crowdsource (\"wen sir/mam\")",
      "  shoutout          — contributor recognition by @handle",
      "  rally             — single-word ALL-CAPS",
      "  thread            — \"quick overview for the new arrivals\"",
      "  journal-cta       — teaser + journal link",
      "  ugc-repost        — amplify a third-party user reaction",
      "",
      "Draft formats (1clawai / Bankr campaign):",
      "  holder-milestone  — holder count threshold (500/1k/2.5k/5k)",
      "  onchain-stats     — weekly holders + fees + activity ratio",
      "  listing-news      — CoinGecko / CMC / DexScreener / MEXC",
      "  reference-demo    — 4-layer-loop demo (DID→push→LLM→mint→sign)",
      "  editorial-coverage— Gate Learn / newsletter mention drop",
      "  ecosystem-partner — confirmed Bankr-ecosystem integration",
      "  essay             — 1claw.xyz/journal teaser",
      "  stack-diagram     — 4-layer stack visual, 1Claw highlighted",
      "  bankr-amplified   — engineered for an @bankr repost",
      "  auto              — let the model pick",
      "",
      "Examples:",
      "  pnpm cmo draft \"v0.21.2 ships key expiration\" --format release",
      "  pnpm cmo post --channel builders --file release.md --auto-format",
      "  echo \"hello builders\" | pnpm cmo post --channel builders - --send",
      "  pnpm cmo x --thread snap-thread.json --send",
      "  pnpm cmo quotes --anchor 1834567890123456789 --max 50",
      "",
      "post / x defaults: dry-run unless --send.",
    ].join("\n"),
  );
  process.exit(2);
}

interface DraftArgs {
  topic: string;
  format: CmoPostFormat;
  candidates: number;
  context?: string;
  model?: string;
}

function parseDraftArgs(rest: string[]): DraftArgs {
  if (rest.length === 0) usage();
  let topic = "";
  let format: CmoPostFormat = "auto";
  let candidates = 4;
  let context: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--format") format = rest[++i] as CmoPostFormat;
    else if (a === "--candidates") candidates = Number(rest[++i]);
    else if (a === "--context") context = rest[++i];
    else if (a === "--model") model = rest[++i];
    else if (a.startsWith("--")) usage();
    else topic = topic ? `${topic} ${a}` : a;
  }
  if (!topic) usage();
  return { topic, format, candidates, context, model };
}

interface PostArgs {
  channel: string;
  text: string;
  parseMode: SnapParseMode;
  send: boolean;
  autoFormat: boolean;
  allowPreview: boolean;
}

function normalizeParseMode(s: string | undefined): SnapParseMode {
  switch ((s ?? "markdown_v2").toLowerCase()) {
    case "markdown_v2":
    case "markdownv2": return "MarkdownV2";
    case "markdown":   return "Markdown";
    case "html":       return "HTML";
    case "none":       return "none";
    default: usage();
  }
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function parsePostArgs(rest: string[]): PostArgs {
  let channel = "";
  let text = "";
  let parseModeFlag: string | undefined;
  let send = false;
  let autoFormat = false;
  let allowPreview = false;
  let stdinFlag = false;
  let fromFile: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--channel") channel = rest[++i] ?? "";
    else if (a === "--message") text = rest[++i] ?? "";
    else if (a === "--file") fromFile = rest[++i];
    else if (a === "--parse-mode") parseModeFlag = rest[++i];
    else if (a === "--send") send = true;
    else if (a === "--auto-format") autoFormat = true;
    else if (a === "--allow-preview") allowPreview = true;
    else if (a === "-") stdinFlag = true;
    else if (a.startsWith("--")) usage();
  }
  if (!channel) usage();
  if (fromFile) text = readFileSync(fromFile, "utf8");
  if (stdinFlag) text = readStdin();
  if (!text.trim()) usage();
  return {
    channel,
    text,
    parseMode: normalizeParseMode(parseModeFlag),
    send,
    autoFormat,
    allowPreview,
  };
}

async function runDraft(rest: string[]): Promise<void> {
  const args = parseDraftArgs(rest);
  const result = await generateDrafts(args);
  console.log(`\nTopic: ${result.topic}`);
  console.log(`Drafts (${result.drafts.length}):\n`);
  result.drafts.forEach((d, i) => {
    const over = d.charCount > 280 ? "  ⚠ OVER 280" : "";
    console.log(`--- [${i + 1}] (${d.charCount} chars)${over}`);
    console.log(d.text);
    console.log();
  });
}

async function runPost(rest: string[]): Promise<void> {
  const args = parsePostArgs(rest);
  let text = args.text;
  if (args.autoFormat) {
    if (args.parseMode === "MarkdownV2") text = toMarkdownV2(text);
    else {
      console.error("[cmo post] --auto-format only supports MarkdownV2; ignoring.");
    }
  }
  const result = await postToSnap({
    channel: args.channel,
    text,
    parseMode: args.parseMode,
    dryRun: !args.send,
    disablePreview: !args.allowPreview,
  });
  console.log(`Channel slug : ${args.channel}`);
  console.log(`chat_id      : ${result.body.chat_id}`);
  console.log(`parse_mode   : ${result.body.parse_mode ?? "(none)"}`);
  console.log(`disable_prev : ${result.body.disable_web_page_preview}`);
  console.log(`URL          : ${result.url}`);
  console.log(`Mode         : ${result.dryRun ? "DRY RUN (pass --send to fire)" : "SENT"}`);
  console.log("\n----- message body -----");
  console.log(text);
  console.log("------------------------\n");
  if (!result.dryRun) {
    const ok = result.response?.ok === true;
    console.log(`Telegram response: ${ok ? "ok ✅" : "FAILED ❌"}`);
    if (!ok) {
      console.log(`Description     : ${result.response?.description ?? "(none)"}`);
      process.exitCode = 1;
    }
  }
}

async function runChannel(rest: string[]): Promise<void> {
  const slug = rest[0];
  if (!slug) usage();
  const chatId = await resolveChannel(slug);
  console.log(JSON.stringify({ channel: slug, chat_id: chatId }));
}

interface XArgs {
  threadPath: string;
  send: boolean;
}

function parseXArgs(rest: string[]): XArgs {
  let threadPath = "";
  let send = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--thread") threadPath = rest[++i] ?? "";
    else if (a === "--send") send = true;
    else if (a.startsWith("--")) usage();
  }
  if (!threadPath) usage();
  return { threadPath, send };
}

interface QuotesArgs {
  anchorId: string;
  sinceId?: string;
  max?: number;
}

function parseQuotesArgs(rest: string[]): QuotesArgs {
  let anchorId = "";
  let sinceId: string | undefined;
  let max: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--anchor") anchorId = rest[++i] ?? "";
    else if (a === "--since") sinceId = rest[++i];
    else if (a === "--max") max = Number(rest[++i]);
    else if (a.startsWith("--")) usage();
  }
  if (!anchorId) usage();
  return { anchorId, sinceId, max };
}

async function runQuotes(rest: string[]): Promise<void> {
  const args = parseQuotesArgs(rest);
  const quotes = await fetchQuoteTweets(args.anchorId, {
    sinceId: args.sinceId,
    max: args.max,
  });
  // Machine-readable JSON to stdout; human-readable summary to stderr so
  // a calling script can `pnpm cmo quotes ... | jq` without parsing
  // mixed output.
  console.error(
    `Found ${quotes.length} quote-tweet${quotes.length === 1 ? "" : "s"} for anchor ${args.anchorId}` +
      (args.sinceId ? ` (since ${args.sinceId})` : ""),
  );
  console.log(JSON.stringify(quotes, null, 2));
}

async function runX(rest: string[]): Promise<void> {
  const args = parseXArgs(rest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.threadPath, "utf8"));
  } catch (err) {
    console.error(`[cmo x] could not read ${args.threadPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  // Accept either a bare array of tweets or { tweets: [...] }.
  const tweets = Array.isArray(parsed)
    ? parsed
    : (parsed as { tweets?: unknown }).tweets;
  if (!Array.isArray(tweets)) {
    console.error(
      `[cmo x] ${args.threadPath} must be an array of tweets, or an object with a "tweets" array.`,
    );
    process.exit(2);
  }
  const input: XThreadInput = {
    tweets: tweets as XThreadInput["tweets"],
    dryRun: !args.send,
  };
  const result = await postThread(input);
  console.log(`Mode   : ${result.dryRun ? "DRY RUN (pass --send to fire)" : "SENT"}`);
  console.log(`Account: ${result.account}`);
  console.log("");
  result.tweets.forEach((t, i) => {
    console.log(`--- [${i + 1}/${result.tweets.length}] id=${t.id}`);
    console.log(`URL       : ${t.url}`);
    console.log(`Reply to  : ${t.replyToId ?? "(none — anchor tweet)"}`);
    console.log(`Media     : ${t.mediaCount}`);
    console.log(`Chars     : ${[...t.text].length}`);
    console.log("");
    console.log(t.text);
    console.log("");
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  switch (cmd) {
    case "draft":   await runDraft(rest);   break;
    case "post":    await runPost(rest);    break;
    case "channel": await runChannel(rest); break;
    case "x":       await runX(rest);       break;
    case "quotes":  await runQuotes(rest);  break;
    default: usage();
  }
}

main().catch((err) => {
  console.error("[cmo] failed:", err.message ?? err);
  process.exit(1);
});
