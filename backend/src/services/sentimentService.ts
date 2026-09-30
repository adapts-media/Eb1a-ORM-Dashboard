import { env, assertAiConfigured, refreshEnvFromDisk } from "../config/env";
import { SentimentLabel, MentionClassification, MentionContext, RelevanceMethod } from "../types/normalized";

export class AiSentimentError extends Error {
  status?: number;
  rateLimited: boolean;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AiSentimentError";
    this.status = status;
    this.rateLimited = status === 429;
  }
}

// Sentiment-only prompt — used whenever relevance is already known (the
// subject's name is literally present in the text). Unchanged from the
// original classifier so the common case costs exactly what it always did.
const SENTIMENT_ONLY_PROMPT = `You are a sentiment classification engine for social media monitoring.
Classify the sentiment of the given text as exactly one of: POSITIVE, NEGATIVE, NEUTRAL.

Judge sentiment from overall meaning and context, not from the presence of individual
"negative" or "positive" words in isolation. Handle negation, sarcasm cues, and mixed
statements sensibly. For example, "This phone is not bad at all" is POSITIVE (or NEUTRAL
at worst), not NEGATIVE, because the negation flips the word "bad". Similarly "not great"
leans NEGATIVE/NEUTRAL despite containing "great".

Respond with ONLY a compact JSON object, no prose, no markdown fences, in exactly this shape:
{"sentiment":"POSITIVE|NEGATIVE|NEUTRAL","confidence":0.0-1.0}
confidence is your calibrated confidence in the label, from 0 to 1.`;

/**
 * Relevance + sentiment prompt — only used when a cheap string match can't
 * already confirm the text is about the subject. Asks for both fields in
 * the SAME call rather than a second round-trip, so adding the relevance
 * check does not double AI spend.
 */
function buildRelevancePrompt(subjects: string[]): string {
  const subjectList = subjects.map((s) => `"${s}"`).join(" or ");
  return `You are a brand-monitoring classification engine for social media monitoring.

First decide RELEVANCE: is this text actually ABOUT ${subjectList} specifically — the
author is discussing, asking about, reviewing, comparing, or directly referencing that
entity (including by clear pronoun/context reference to it) — as opposed to a generic or
unrelated discussion that merely shares the same general topic without actually being
about ${subjectList}. If genuinely unsure, prefer relevant:true rather than silently
hiding a real mention.

Then, classify sentiment as exactly one of: POSITIVE, NEGATIVE, NEUTRAL, judging overall
meaning and context (not individual words in isolation; handle negation and sarcasm
sensibly). If a CONTEXT block is provided before the text, use it only to understand what
the text is replying to — classify the text itself, not the context.

Respond with ONLY a compact JSON object, no prose, no markdown fences, in exactly this shape:
{"relevant":true|false,"sentiment":"POSITIVE|NEGATIVE|NEUTRAL","confidence":0.0-1.0}
confidence is your calibrated confidence in the sentiment label, from 0 to 1.`;
}

function buildUserMessage(text: string, context?: MentionContext): string {
  if (!context || (!context.postTitle && !context.parentText)) return text;

  const lines: string[] = ["[CONTEXT — for reference only, do NOT classify this]"];
  if (context.postTitle) lines.push(`Post title: ${context.postTitle}`);
  if (context.parentText) lines.push(`Replying to: "${context.parentText.slice(0, 300)}"`);
  lines.push("[END CONTEXT]", "", "[TEXT TO CLASSIFY]", text);
  return lines.join("\n");
}

export interface ClassifyMentionInput {
  text: string;
  /** Brand or competitor name to check relevance against. */
  subject: string;
  /** Extra known spelling variants of the subject. */
  subjectVariants?: string[];
  /** Post title / immediate parent comment text, for a reply. */
  context?: MentionContext;
}

/**
 * SentimentService — the ONLY module that talks to the AI provider. It is
 * intentionally decoupled from ApifyService/DataNormalizer: it just takes
 * plain text in and returns a classification. Swapping AI providers later
 * means changing only this file (and AI_API_URL/AI_MODEL in .env), never
 * the Apify integration.
 *
 * Assumes an OpenAI-compatible /chat/completions endpoint. If your provider
 * differs, adjust `callChatCompletions` below — everything else stays the
 * same.
 */

/**
 * Classifies a mention's sentiment, checking relevance to `subject` first.
 * Always exactly ONE AI call:
 *  - If `text` obviously contains `subject` (or a `subjectVariants` alias) —
 *    cheap string match, no AI involved — relevance is already certain, so
 *    the short sentiment-only prompt is used (same cost as before this
 *    feature existed).
 *  - Otherwise (indirect/pronoun reference, or the item came from a broad,
 *    non-exact search query) — genuinely ambiguous, so relevance and
 *    sentiment are judged together in the same call via the expanded prompt.
 */
export async function classifyMention(input: ClassifyMentionInput): Promise<MentionClassification> {
  await refreshEnvFromDisk();
  assertAiConfigured();

  const trimmed = (input.text ?? "").trim();
  if (!trimmed) {
    throw new AiSentimentError("Cannot classify empty text.");
  }

  const subjects = [input.subject, ...(input.subjectVariants ?? [])].map((s) => s.trim()).filter(Boolean);
  const userMessage = buildUserMessage(trimmed, input.context);

  if (subjects.length > 0 && containsAnySubject(trimmed, subjects)) {
    const raw = await callWithRetry(userMessage, SENTIMENT_ONLY_PROMPT);
    const result = parseSentimentOutput(raw);
    return { ...result, relevant: true, relevanceMethod: "keyword_match" };
  }

  const raw = await callWithRetry(userMessage, buildRelevancePrompt(subjects.length > 0 ? subjects : [input.subject]));
  const result = parseRelevanceOutput(raw);
  return { ...result, relevanceMethod: "ai_check" as RelevanceMethod };
}

/** Cheap, free pre-filter: does the text literally contain one of the subject terms? */
function containsAnySubject(text: string, subjects: string[]): boolean {
  const normalizedText = normalize(text);
  return subjects.some((s) => normalizedText.includes(normalize(s)));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Backoff delays for transient Mistral failures (429 rate limit, 5xx, timeouts/network).
const RETRY_DELAYS_MS = [2000, 5000, 15000];

async function callWithRetry(text: string, systemPrompt: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callChatCompletions(text, systemPrompt);
    } catch (err) {
      const status = err instanceof AiSentimentError ? err.status : undefined;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function callChatCompletions(text: string, systemPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const endpoint = env.AI_API_URL || "https://api.mistral.ai/v1/chat/completions";
  const model = env.AI_MODEL || "open-mistral-7b";

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text.slice(0, 4000) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new AiSentimentError("Mistral AI sentiment request timed out.");
    }
    throw new AiSentimentError(`Could not reach Mistral AI API at ${endpoint}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AiSentimentError("Mistral AI API rejected the request — check MISTRAL_API_KEY in Settings.", response.status);
  }
  if (response.status === 429) {
    throw new AiSentimentError("Mistral AI API rate limit exceeded. Try again in a few moments.", 429);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AiSentimentError(`Mistral AI request failed with status ${response.status}: ${text.slice(0, 500)}`, response.status);
  }

  const json: any = await response.json().catch(() => null);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AiSentimentError("AI API response did not contain the expected choices[0].message.content field.");
  }
  return content;
}

function stripFences(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
}

function parseSentimentOutput(raw: string): { sentiment: SentimentLabel; confidence: number | null } {
  const cleaned = stripFences(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fall back to scanning for a label if the model didn't return clean JSON.
    const label = extractLabelFallback(cleaned);
    if (label) return { sentiment: label, confidence: null };
    throw new AiSentimentError("Could not parse sentiment from AI response.");
  }

  const label = normalizeLabel(parsed?.sentiment);
  if (!label) {
    throw new AiSentimentError(`AI response had an unrecognized sentiment value: ${JSON.stringify(parsed?.sentiment)}`);
  }

  return { sentiment: label, confidence: normalizeConfidence(parsed?.confidence) };
}

function parseRelevanceOutput(raw: string): { sentiment: SentimentLabel; confidence: number | null; relevant: boolean } {
  const cleaned = stripFences(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const label = extractLabelFallback(cleaned);
    if (label) {
      // Couldn't parse the relevance flag — default to relevant so we never
      // silently hide a real mention because of a malformed AI response.
      return { relevant: true, sentiment: label, confidence: null };
    }
    throw new AiSentimentError("Could not parse relevance/sentiment from AI response.");
  }

  const label = normalizeLabel(parsed?.sentiment);
  if (!label) {
    throw new AiSentimentError(`AI response had an unrecognized sentiment value: ${JSON.stringify(parsed?.sentiment)}`);
  }

  const relevant = typeof parsed?.relevant === "boolean" ? parsed.relevant : true;
  return { relevant, sentiment: label, confidence: normalizeConfidence(parsed?.confidence) };
}

function normalizeConfidence(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return Math.max(0, Math.min(1, val));
  }
  return null;
}

function normalizeLabel(val: unknown): SentimentLabel | null {
  if (typeof val !== "string") return null;
  const upper = val.trim().toUpperCase();
  if (upper === "POSITIVE" || upper === "NEGATIVE" || upper === "NEUTRAL") return upper;
  return null;
}

function extractLabelFallback(text: string): SentimentLabel | null {
  const upper = text.toUpperCase();
  if (upper.includes("POSITIVE")) return "POSITIVE";
  if (upper.includes("NEGATIVE")) return "NEGATIVE";
  if (upper.includes("NEUTRAL")) return "NEUTRAL";
  return null;
}
