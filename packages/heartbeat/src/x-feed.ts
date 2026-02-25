/**
 * x-feed.ts — X (Twitter) feed monitoring for the intent computer
 *
 * Uses rettiwt-api to poll curated lists, bookmarks, and feeds,
 * then writes high-signal content to ~/Mind/inbox/ for pipeline processing.
 *
 * Authentication: uses a base64-encoded cookie string (API_KEY) stored in
 * the vault at ops/secrets/x-api-key.txt. Generate this key using the
 * rettiwt-api browser extension.
 *
 * Usage:
 *   import { pollXFeeds } from "./x-feed.js";
 *   await pollXFeeds(vaultRoot, { sources: ["lists", "bookmarks"] });
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Rettiwt } from "rettiwt-api";
import type { FeedCapture, PerceptionContext, SourceCursor } from "@intent-computer/architecture";
import type { FeedSource } from "./perception-runtime.js";
import {
  readCursors,
  writeCursors,
  getCursor,
  updateCursor,
  pruneCursor,
} from "./cursor-store.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type XFeedSource = "lists" | "bookmarks" | "following" | "recommended";

export interface XFeedOptions {
  /** Which sources to poll. Default: ["lists", "bookmarks"] */
  sources?: XFeedSource[];
  /** Max tweets per source. Default: 50 */
  maxPerSource?: number;
  /** List IDs to poll (required if sources includes "lists") */
  listIds?: string[];
  /** Only include tweets with URLs (blog posts, articles, videos). Default: true */
  urlsOnly?: boolean;
  /** Keywords to boost relevance scoring. Derived from active commitments. */
  relevanceKeywords?: string[];
  /** Path to the API key file. Default: ops/secrets/x-api-key.txt */
  apiKeyPath?: string;
  /** Dry run — log what would be captured without writing inbox files. */
  dryRun?: boolean;
}

export interface CapturedTweet {
  id: string;
  author: string;
  authorHandle: string;
  text: string;
  urls: string[];
  createdAt: string;
  source: XFeedSource;
  listId?: string;
  relevanceScore: number;
  isThread: boolean;
  threadLength?: number;
}

export interface XFeedResult {
  captured: CapturedTweet[];
  written: number;
  skipped: number;
  errors: string[];
}

// ─── Cursor-based state tracking (dedup across runs) ─────────────────────────

const X_FEED_SOURCE_ID = "x-feed";
const MAX_RETAINED_IDS = 2000;

function loadSeenIds(vaultRoot: string): Set<string> {
  const store = readCursors(vaultRoot);
  const cursor = getCursor(store, X_FEED_SOURCE_ID);
  if (cursor && cursor.type === "id-set") {
    return new Set(cursor.seenIds);
  }
  return new Set();
}

function saveSeenIds(vaultRoot: string, seenIds: string[]): void {
  let store = readCursors(vaultRoot);
  let cursor: SourceCursor = {
    type: "id-set",
    seenIds,
    maxRetained: MAX_RETAINED_IDS,
  };
  cursor = pruneCursor(cursor);
  store = updateCursor(store, X_FEED_SOURCE_ID, cursor);
  writeCursors(vaultRoot, store);
}

// ─── API key loading ─────────────────────────────────────────────────────────

function loadApiKey(vaultRoot: string, customPath?: string): string | null {
  const keyPath = customPath ?? join(vaultRoot, "ops", "secrets", "x-api-key.txt");
  if (!existsSync(keyPath)) {
    return null;
  }
  try {
    return readFileSync(keyPath, "utf-8").trim();
  } catch {
    return null;
  }
}

// ─── URL extraction ──────────────────────────────────────────────────────────

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s\)]+/g;
  const matches = text.match(urlRegex) ?? [];
  // Filter out t.co tracking links if the expanded URL is also present
  return matches.filter((url) => !url.startsWith("https://t.co/") || matches.length === 1);
}

// ─── Relevance scoring ──────────────────────────────────────────────────────

function scoreRelevance(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0.5;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return Math.min(1, hits / Math.max(1, keywords.length / 3));
}

// ─── Tweet → inbox markdown ─────────────────────────────────────────────────

function tweetToInboxMarkdown(tweet: CapturedTweet): string {
  const lines: string[] = [
    `# X capture: ${tweet.author} (@${tweet.authorHandle})`,
    "",
    `Source: https://x.com/${tweet.authorHandle}/status/${tweet.id}`,
    `Captured: ${new Date().toISOString().split("T")[0]}`,
    `Feed source: ${tweet.source}${tweet.listId ? ` (list: ${tweet.listId})` : ""}`,
    `Relevance score: ${tweet.relevanceScore.toFixed(2)}`,
    "",
    "---",
    "",
    tweet.text,
    "",
  ];

  if (tweet.urls.length > 0) {
    lines.push("## Linked Content", "");
    for (const url of tweet.urls) {
      lines.push(`- ${url}`);
    }
    lines.push("");
  }

  if (tweet.isThread) {
    lines.push(`*Thread with ${tweet.threadLength ?? "multiple"} posts — expand for full context.*`, "");
  }

  return lines.join("\n");
}

function sanitizeFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80)
    .replace(/-+$/, "");
}

// ─── Core polling logic ─────────────────────────────────────────────────────

async function pollSource(
  rettiwt: InstanceType<typeof Rettiwt>,
  source: XFeedSource,
  options: XFeedOptions,
): Promise<CapturedTweet[]> {
  const max = options.maxPerSource ?? 50;
  const captured: CapturedTweet[] = [];

  try {
    switch (source) {
      case "lists": {
        const listIds = options.listIds ?? [];
        for (const listId of listIds) {
          const response = await rettiwt.list.tweets(listId, max);
          for (const tweet of response.list) {
            const text = tweet.fullText ?? "";
            const urls = extractUrls(text);
            if (options.urlsOnly && urls.length === 0) continue;
            captured.push({
              id: tweet.id,
              author: tweet.tweetBy?.fullName ?? "unknown",
              authorHandle: tweet.tweetBy?.userName ?? "unknown",
              text,
              urls,
              createdAt: tweet.createdAt ?? new Date().toISOString(),
              source: "lists",
              listId,
              relevanceScore: scoreRelevance(text, options.relevanceKeywords ?? []),
              isThread: (tweet.replyCount ?? 0) > 0 && tweet.conversationId === tweet.id,
              threadLength: undefined,
            });
          }
        }
        break;
      }

      case "bookmarks": {
        const response = await rettiwt.user.bookmarks(max);
        for (const tweet of response.list) {
          const text = tweet.fullText ?? "";
          const urls = extractUrls(text);
          captured.push({
            id: tweet.id,
            author: tweet.tweetBy?.fullName ?? "unknown",
            authorHandle: tweet.tweetBy?.userName ?? "unknown",
            text,
            urls,
            createdAt: tweet.createdAt ?? new Date().toISOString(),
            source: "bookmarks",
            relevanceScore: scoreRelevance(text, options.relevanceKeywords ?? []),
            isThread: (tweet.replyCount ?? 0) > 0 && tweet.conversationId === tweet.id,
            threadLength: undefined,
          });
        }
        break;
      }

      case "following": {
        const response = await rettiwt.user.followed();
        for (const tweet of response.list) {
          const text = tweet.fullText ?? "";
          const urls = extractUrls(text);
          if (options.urlsOnly && urls.length === 0) continue;
          captured.push({
            id: tweet.id,
            author: tweet.tweetBy?.fullName ?? "unknown",
            authorHandle: tweet.tweetBy?.userName ?? "unknown",
            text,
            urls,
            createdAt: tweet.createdAt ?? new Date().toISOString(),
            source: "following",
            relevanceScore: scoreRelevance(text, options.relevanceKeywords ?? []),
            isThread: (tweet.replyCount ?? 0) > 0 && tweet.conversationId === tweet.id,
            threadLength: undefined,
          });
        }
        break;
      }

      case "recommended": {
        const response = await rettiwt.user.recommended();
        for (const tweet of response.list) {
          const text = tweet.fullText ?? "";
          const urls = extractUrls(text);
          if (options.urlsOnly && urls.length === 0) continue;
          captured.push({
            id: tweet.id,
            author: tweet.tweetBy?.fullName ?? "unknown",
            authorHandle: tweet.tweetBy?.userName ?? "unknown",
            text,
            urls,
            createdAt: tweet.createdAt ?? new Date().toISOString(),
            source: "recommended",
            relevanceScore: scoreRelevance(text, options.relevanceKeywords ?? []),
            isThread: (tweet.replyCount ?? 0) > 0 && tweet.conversationId === tweet.id,
            threadLength: undefined,
          });
        }
        break;
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[x-feed] Error polling ${source}: ${msg}`);
  }

  return captured;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function pollXFeeds(
  vaultRoot: string,
  options: XFeedOptions = {},
): Promise<XFeedResult> {
  const result: XFeedResult = { captured: [], written: 0, skipped: 0, errors: [] };

  // Load API key
  const apiKey = loadApiKey(vaultRoot, options.apiKeyPath);
  if (!apiKey) {
    result.errors.push(
      `No X API key found. Create ${join(vaultRoot, "ops", "secrets", "x-api-key.txt")} ` +
      "with your rettiwt-api key (base64-encoded cookies from the browser extension).",
    );
    console.error(`[x-feed] ${result.errors[0]}`);
    return result;
  }

  // Initialize client
  const rettiwt = new Rettiwt({ apiKey });

  // Load dedup state from shared cursor store
  const seenSet = loadSeenIds(vaultRoot);
  const newIds: string[] = [...seenSet];

  // Poll each source
  const sources = options.sources ?? ["lists", "bookmarks"];
  for (const source of sources) {
    const tweets = await pollSource(rettiwt, source, options);
    for (const tweet of tweets) {
      // Dedup
      if (seenSet.has(tweet.id)) {
        result.skipped++;
        continue;
      }
      seenSet.add(tweet.id);
      newIds.push(tweet.id);
      result.captured.push(tweet);
    }
  }

  // Sort by relevance, highest first
  result.captured.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Write to inbox
  const inboxDir = join(vaultRoot, "inbox");
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });

  for (const tweet of result.captured) {
    if (options.dryRun) {
      console.log(`[x-feed][dry-run] Would capture: @${tweet.authorHandle} (${tweet.id}) score=${tweet.relevanceScore.toFixed(2)}`);
      continue;
    }

    const slug = sanitizeFilename(`x-${tweet.authorHandle}-${tweet.id.slice(-8)}`);
    const filePath = join(inboxDir, `${slug}.md`);

    if (existsSync(filePath)) {
      result.skipped++;
      continue;
    }

    const markdown = tweetToInboxMarkdown(tweet);
    writeFileSync(filePath, markdown, "utf-8");
    result.written++;
    console.log(`[x-feed] Captured: @${tweet.authorHandle} → ${filePath}`);
  }

  // Save cursor state
  saveSeenIds(vaultRoot, newIds);

  console.log(`[x-feed] Poll complete: ${result.captured.length} captured, ${result.written} written, ${result.skipped} skipped`);
  return result;
}

// ─── FeedSource adapter ──────────────────────────────────────────────────────

/**
 * Creates a FeedSource adapter wrapping the existing x-feed polling logic
 * into the standardized perception runtime interface.
 */
export function createXFeedSource(vaultRoot: string): FeedSource {
  const apiKey = loadApiKey(vaultRoot);
  const enabled = apiKey != null;

  return {
    id: "x-feed",
    name: "X (Twitter)",
    enabled,
    pollIntervalMinutes: 15,
    maxItemsPerPoll: 50,

    async poll(_vaultRoot: string, context: PerceptionContext): Promise<FeedCapture[]> {
      const keywords = extractCommitmentKeywords(context.commitmentLabels);

      const result = await pollXFeeds(_vaultRoot, {
        sources: ["lists", "bookmarks"],
        relevanceKeywords: keywords,
        dryRun: true, // Don't write to inbox — perception runtime handles writes
      });

      // Convert CapturedTweet[] → FeedCapture[]
      return result.captured.map((tweet): FeedCapture => ({
        id: tweet.id,
        sourceId: "x-feed",
        capturedAt: new Date().toISOString(),
        title: `@${tweet.authorHandle}: ${tweet.text.slice(0, 100)}`,
        content: tweet.text,
        urls: tweet.urls,
        metadata: {
          author: tweet.author,
          authorHandle: tweet.authorHandle,
          source: tweet.source,
          listId: tweet.listId ?? "",
          isThread: tweet.isThread,
          threadLength: tweet.threadLength ?? 0,
        },
        rawRelevanceScore: tweet.relevanceScore,
      }));
    },

    toInboxMarkdown(capture: FeedCapture): string {
      const meta = capture.metadata as Record<string, unknown>;
      const authorHandle = String(meta.authorHandle ?? "unknown");
      const author = String(meta.author ?? "unknown");
      const source = String(meta.source ?? "feed");
      const listId = meta.listId ? ` (list: ${String(meta.listId)})` : "";
      const isThread = Boolean(meta.isThread);
      const threadLength = meta.threadLength;

      const lines: string[] = [
        `# X capture: ${author} (@${authorHandle})`,
        "",
        `Source: https://x.com/${authorHandle}/status/${capture.id}`,
        `Captured: ${capture.capturedAt.split("T")[0]}`,
        `Feed source: ${source}${listId}`,
        `Relevance score: ${capture.rawRelevanceScore.toFixed(2)}`,
        "",
        "---",
        "",
        capture.content,
        "",
      ];

      if (capture.urls.length > 0) {
        lines.push("## Linked Content", "");
        for (const url of capture.urls) {
          lines.push(`- ${url}`);
        }
        lines.push("");
      }

      if (isThread) {
        lines.push(
          `*Thread with ${threadLength || "multiple"} posts — expand for full context.*`,
          "",
        );
      }

      return lines.join("\n");
    },
  };
}

// ─── Commitment-aligned keyword extraction ──────────────────────────────────

/**
 * Extract relevance keywords from active commitments.
 * Used to score tweets against what the vault currently cares about.
 */
export function extractCommitmentKeywords(commitmentLabels: string[]): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "and", "or", "but", "for", "with", "from",
    "into", "out", "about", "next", "pipeline", "research", "complete",
  ]);

  const keywords: string[] = [];
  for (const label of commitmentLabels) {
    const words = label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
    keywords.push(...words);
  }

  return [...new Set(keywords)];
}
