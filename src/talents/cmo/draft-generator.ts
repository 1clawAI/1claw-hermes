import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShroudClient } from "../../shroud/index.js";

/**
 * Post formats lifted from the gitlawb analysis. Each one steers the
 * model toward a different shape; the caller picks one (or "auto" to
 * let the model decide based on the topic).
 */
export type CmoPostFormat =
  // gitlawb-style developer-tool formats
  | "newsdrop"           // ship → 1-line thesis
  | "stats"              // bare numbers + install command
  | "qt"                 // quote-tweet hijack (1-line)
  | "qt-bigissue"        // 3-paragraph claim → why → product-anchor QT
  | "milestone"          // "N stars!" hashtag-stamped one-liner
  | "release"            // version + headline metric + reply-thread bullets
  | "dogfood"            // "we shipped X using our own Y"
  | "poll"               // crypto-native poll / crowdsource ("wen sir/mam")
  | "shoutout"           // contributor recognition by @handle
  | "rally"              // single-word ALL-CAPS rally
  | "thread"             // "quick overview for the new arrivals" long-form
  | "journal-cta"        // teaser + link to 1claw.xyz/journal/...
  | "ugc-repost"         // amplify a third-party user's organic reaction
  // 1clawai token + Bankr-ecosystem formats (campaign.md)
  | "holder-milestone"   // holder count crosses 500 / 1k / 2.5k / 5k
  | "onchain-stats"      // weekly holders + fees + transfer/approve ratio
  | "listing-news"       // CoinGecko / CMC / DexScreener / MEXC announcement
  | "reference-demo"     // 4-layer-loop demo (DID → push → LLM → mint → sign)
  | "editorial-coverage" // Gate Learn / Zeneca / newsletter mention
  | "ecosystem-partner"  // confirmed Bankr-ecosystem integration
  | "essay"              // 1claw.xyz/journal teaser
  | "stack-diagram"      // 4-layer stack visual, 1Claw highlighted
  | "bankr-amplified"    // engineered to be reposted by @bankr
  | "auto";

export interface CmoDraftInput {
  topic: string;
  format?: CmoPostFormat;
  /** Number of candidate drafts to generate. Default 4. */
  candidates?: number;
  /** Optional context, e.g. quoted tweet text for the `qt` format. */
  context?: string;
  /** Optional model override. Defaults to the shroud-configured model. */
  model?: string;
}

export interface CmoDraft {
  format: CmoPostFormat;
  text: string;
  charCount: number;
}

export interface CmoDraftResult {
  topic: string;
  drafts: CmoDraft[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

function loadBriefingDoc(name: string): string {
  return readFileSync(join(HERE, name), "utf8");
}

/**
 * Builds the system prompt by concatenating the three briefing docs.
 * Kept out of the request payload so callers can audit it once and
 * not eyeball it on every generation.
 */
export function buildSystemPrompt(): string {
  const persona = loadBriefingDoc("persona.md");
  const styleNotes = loadBriefingDoc("style-notes.md");
  const products = loadBriefingDoc("products.md");
  const campaign = loadBriefingDoc("campaign.md");
  return [
    "You are the CMO talent for @1clawai. Write X (Twitter) posts in",
    "the @gitlawb posting style adapted to the 1claw brand, anchored",
    "to the active 30-day Bankr-ecosystem velocity campaign. The user",
    "approves every draft before it goes live — be bold, not bland.",
    "",
    "=== PERSONA ===",
    persona,
    "",
    "=== ACTIVE CAMPAIGN ===",
    campaign,
    "",
    "=== REFERENCE STYLE (gitlawb) ===",
    styleNotes,
    "",
    "=== PRODUCT CONTEXT ===",
    products,
    "",
    "Constraints:",
    "- 280 char hard cap per post (release-note replies + threads",
    "  may chain multiple 280-char posts; separate with a blank line).",
    "- No emoji unless the topic requires quoting one.",
    "- No 'we're excited to announce', no corporate language.",
    "- No price talk in brand-voice posts. Founder voice (@kmjones1979)",
    "  can reference fees / holders, brand voice stays on product.",
    "- Never invent stats, version numbers, holder counts, or",
    "  contributor counts. Use `{{stat:stars}}`, `{{stat:holders}}`,",
    "  `{{stat:fees_usd}}`, `{{version}}`, `{{handle}}`, `{{date}}`",
    "  as placeholders the user fills in.",
    "- Never claim a partnership, listing, or integration that",
    "  isn't shipped. Soft mentions only for in-flight work",
    "  (e.g. \"listing applications submitted\").",
    "- Never lean into the \"claw\" meme — we are the canonical",
    "  security primitive, not another claw-themed meme token.",
    "- Output ONLY the post text, one candidate per line, separated",
    "  by a line containing exactly '---'. No commentary, no",
    "  numbering, no markdown formatting.",
  ].join("\n");
}

function userPrompt(input: CmoDraftInput, n: number): string {
  const format = input.format ?? "auto";
  const lines = [
    `Topic: ${input.topic}`,
    `Format: ${format}`,
    `Generate ${n} candidate drafts.`,
  ];
  if (input.context) {
    lines.push("", "Context / quoted tweet:", input.context);
  }
  if (format === "qt" && !input.context) {
    lines.push("", "(No quoted tweet supplied — write a generic QT-style hook.)");
  }
  return lines.join("\n");
}

function splitCandidates(raw: string): string[] {
  return raw
    .split(/^---\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Generates candidate posts using the configured Shroud LLM proxy.
 * The talent inherits Shroud's redaction + injection inspection so
 * no plaintext secrets ever leak into a generated draft.
 */
export async function generateDrafts(
  input: CmoDraftInput,
): Promise<CmoDraftResult> {
  const n = input.candidates ?? 4;
  if (n < 1 || n > 12) {
    throw new Error("candidates must be between 1 and 12");
  }
  const llm = createShroudClient();
  const completion = await llm.chat.completions.create({
    model: input.model ?? "claude-sonnet-4-20250514",
    temperature: 0.85,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userPrompt(input, n) },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  const texts = splitCandidates(raw);
  const drafts: CmoDraft[] = texts.map((text) => ({
    format: input.format ?? "auto",
    text,
    charCount: text.length,
  }));
  return { topic: input.topic, drafts };
}
