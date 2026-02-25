/**
 * capture-heuristic.ts — Lightweight insight detection for Stop hook
 *
 * Pure functions for detecting capturable insights in assistant transcript text.
 * Exported separately from stop-capture.ts so they can be unit-tested without
 * spawning the full hook script.
 *
 * Design principle: conservative over permissive. False positives erode trust
 * in the capture system faster than missed insights do.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedCapture {
  claim: string;
  category: "decision" | "discovery" | "architecture" | "debug";
  context: string;
  confidence: number; // 1 = strong single signal, 2+ = multiple pattern matches
}

export interface TranscriptEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** Minimum number of multi-pattern hits needed for a non-strong-signal capture. */
export const MIN_PATTERN_MATCHES = 2;

/** Maximum word-overlap ratio for deduplication (60% match → considered duplicate). */
export const DEDUP_SIMILARITY_THRESHOLD = 0.6;

interface CapturePattern {
  regex: RegExp;
  category: "decision" | "discovery" | "architecture" | "debug";
  extractClaim: (match: RegExpMatchArray) => string | null;
}

const CAPTURE_PATTERNS: CapturePattern[] = [
  // Decisions
  {
    regex: /\b(?:let['']s|we should|the right approach is|going with|decided to|we['']re going with|going to use)\s+([^.!?\n]{10,80})/gi,
    category: "decision",
    extractClaim: (match) => {
      const d = match[1]?.trim();
      if (!d || d.length < 10) return null;
      return `the decision is to ${d}`.toLowerCase().replace(/\s+/g, " ").trim();
    },
  },
  // Discoveries
  {
    regex: /\b(?:found that|turns out|it turns out|realized that|the issue (?:is|was)|discovered that|the problem (?:is|was))\s+([^.!?\n]{10,100})/gi,
    category: "discovery",
    extractClaim: (match) => {
      const d = match[1]?.trim();
      if (!d || d.length < 10) return null;
      return d.toLowerCase().replace(/\s+/g, " ").trim();
    },
  },
  // Architecture / tradeoffs
  {
    regex: /\b(?:because [^,]+,\s*(?:we need|we should|we must)|the tradeoff (?:is|here is)|this means we(?:'re| are| should)|the reason (?:is|we))\s+([^.!?\n]{10,100})/gi,
    category: "architecture",
    extractClaim: (match) => {
      const d = match[1]?.trim();
      if (!d || d.length < 10) return null;
      return d.toLowerCase().replace(/\s+/g, " ").trim();
    },
  },
  // Debug insights
  {
    regex: /\b(?:the root cause|the fix (?:is|was)|it fails because|the bug (?:is|was)|this breaks because|the error (?:is|was))\s+([^.!?\n]{10,100})/gi,
    category: "debug",
    extractClaim: (match) => {
      const d = match[1]?.trim();
      if (!d || d.length < 10) return null;
      return d.toLowerCase().replace(/\s+/g, " ").trim();
    },
  },
];

/** Strong single-phrase patterns — one match is sufficient. */
const STRONG_SIGNAL_PATTERNS: RegExp[] = [
  /the (?:root cause|fundamental issue|core problem) (?:is|was)\s+[^.]{15,}/i,
  /the key insight (?:here )?is\s+[^.]{15,}/i,
  /this (?:reveals|shows|means) that\s+[^.]{15,}/i,
  /the (?:critical|important) (?:thing|point|observation) (?:here )?is\s+[^.]{15,}/i,
];

// ─── Text extraction ──────────────────────────────────────────────────────────

export function extractTextFromContent(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function parseTranscriptLines(rawLines: string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptEntry;
      if (parsed.type === "assistant" || parsed.type === "user") {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed JSON lines
    }
  }
  return entries;
}

export function extractRecentAssistantText(entries: TranscriptEntry[], turnsBack: number): string {
  const assistantEntries = entries
    .filter((e) => e.type === "assistant" && e.message?.role === "assistant")
    .slice(-turnsBack);

  return assistantEntries
    .map((e) => extractTextFromContent(e.message?.content))
    .filter(Boolean)
    .join("\n\n");
}

// ─── Context extraction ───────────────────────────────────────────────────────

function extractContext(fullText: string, matchedText: string): string {
  const idx = fullText.indexOf(matchedText);
  if (idx === -1) return matchedText;
  const start = Math.max(0, idx - 100);
  const end = Math.min(fullText.length, idx + matchedText.length + 200);
  return fullText.slice(start, end).trim();
}

// ─── Heuristic detection ──────────────────────────────────────────────────────

export function detectCapturableInsights(text: string): DetectedCapture[] {
  if (!text || text.length < 50) return [];

  const captures: DetectedCapture[] = [];

  // Strong single-signal phrases first
  for (const pattern of STRONG_SIGNAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const matchedText = match[0];
      const claim = matchedText.toLowerCase().trim().replace(/\s+/g, " ");
      if (claim.length >= 20 && claim.length <= 200) {
        captures.push({
          claim,
          category: "discovery",
          context: extractContext(text, matchedText),
          confidence: 1,
        });
      }
    }
  }

  // Multi-pattern hit accumulation
  const patternHits = new Map<string, { claim: string; category: "decision" | "discovery" | "architecture" | "debug"; context: string; count: number }>();

  for (const pattern of CAPTURE_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, "gi");
    let match: RegExpMatchArray | null;
    while ((match = regex.exec(text)) !== null) {
      const claim = pattern.extractClaim(match);
      if (!claim || claim.length < 15 || claim.length > 200) continue;

      const key = claim.slice(0, 40).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (!key || key.length < 10) continue;

      const existing = patternHits.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        patternHits.set(key, {
          claim,
          category: pattern.category,
          context: extractContext(text, match[0]),
          count: 1,
        });
      }
    }
  }

  for (const [, hit] of patternHits) {
    if (hit.count >= MIN_PATTERN_MATCHES) {
      captures.push({
        claim: hit.claim,
        category: hit.category,
        context: hit.context,
        confidence: hit.count,
      });
    }
  }

  return captures;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export function normalizeForComparison(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function isDuplicateCapture(claim: string, inboxDir: string): boolean {
  if (!existsSync(inboxDir)) return false;

  const normalizedClaim = normalizeForComparison(claim);
  if (!normalizedClaim || normalizedClaim.length < 10) return false;

  try {
    const files = readdirSync(inboxDir)
      .filter((f) => f.endsWith(".md"))
      .slice(-30);

    for (const file of files) {
      try {
        const content = readFileSync(join(inboxDir, file), "utf-8");
        const titleMatch = content.match(/^title:\s*"([^"]+)"/m);
        if (!titleMatch?.[1]) continue;

        const normalizedExisting = normalizeForComparison(titleMatch[1]);
        const claimWords = normalizedClaim.split(/\s+/).filter((w) => w.length > 3);
        const existingWords = new Set(normalizedExisting.split(/\s+/));
        if (claimWords.length === 0) continue;

        const overlapCount = claimWords.filter((w) => existingWords.has(w)).length;
        if (overlapCount / claimWords.length >= DEDUP_SIMILARITY_THRESHOLD) return true;
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return false;
  }

  return false;
}

// ─── Slug helper ──────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
}
