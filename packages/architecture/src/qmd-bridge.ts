/**
 * qmd-bridge.ts
 *
 * Shells out to the `qmd` CLI and returns structured search results.
 * Three search modes matching qmd's capabilities:
 *   - qmdSearch      → BM25 keyword search (`qmd search`)
 *   - qmdVectorSearch → embedding-based search (`qmd vsearch`)
 *   - qmdDeepSearch   → query expansion + reranking (`qmd query`)
 *
 * Returns empty array if qmd is unavailable — never throws.
 *
 * qmd output format (--json flag):
 *   [{ docid, score, file, title, snippet }, ...]
 *
 * The `file` field uses the qmd:// URI scheme, e.g.:
 *   qmd://thoughts/my-thought.md
 *
 * Path resolution: strip the "qmd://" prefix; the remaining path is
 * relative to the collection root, which for vault-backed collections
 * is directly under vaultRoot (e.g., vaultRoot + "/thoughts/my-thought.md").
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface QmdSearchResult {
  path: string;
  score: number;
  title: string;
  excerpt: string;
  collection?: string;
}

interface QmdRawResult {
  docid: string;
  score: number;
  file: string;
  title: string;
  snippet: string;
}

export interface QmdSearchOptions {
  limit?: number;
  minScore?: number;
  collection?: string;
  /**
   * Vault root used to resolve qmd:// URIs to absolute filesystem paths.
   * If omitted, defaults to ~/Mind.
   */
  vaultRoot?: string;
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a qmd:// URI to an absolute filesystem path.
 *
 * qmd://thoughts/foo.md  →  <vaultRoot>/thoughts/foo.md
 * qmd://self/bar.md      →  <vaultRoot>/self/bar.md
 *
 * If the URI doesn't start with qmd://, return it as-is (may already be
 * an absolute path).
 */
function resolveQmdUri(fileUri: string, vaultRoot: string): string {
  const QMD_SCHEME = "qmd://";
  if (!fileUri.startsWith(QMD_SCHEME)) {
    return fileUri;
  }
  const relative = fileUri.slice(QMD_SCHEME.length);
  return resolve(vaultRoot, relative);
}

// ─── qmd binary discovery ────────────────────────────────────────────────────

function findQmdBinary(): string | null {
  // 1. Honour explicit env override
  const envPath = process.env["QMD_PATH"];
  if (envPath && existsSync(envPath)) return envPath;

  // 2. Common install locations
  const candidates = [
    join(homedir(), ".bun", "bin", "qmd"),
    join(homedir(), ".local", "bin", "qmd"),
    "/usr/local/bin/qmd",
    "/opt/homebrew/bin/qmd",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 3. Assume it's on PATH
  try {
    const result = execFileSync("which", ["qmd"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: "pipe",
    }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // ignore
  }

  return null;
}

// ─── Core exec helper ────────────────────────────────────────────────────────

function runQmd(
  subcommand: string,
  query: string,
  opts: QmdSearchOptions,
): QmdSearchResult[] {
  const bin = findQmdBinary();
  if (!bin) return [];

  const vaultRoot =
    opts.vaultRoot ??
    process.env["INTENT_COMPUTER_VAULT"] ??
    join(homedir(), "Mind");

  const args: string[] = [subcommand, query, "--json"];

  if (opts.limit != null && opts.limit > 0) {
    args.push("-n", String(opts.limit));
  }
  if (opts.minScore != null) {
    args.push("--min-score", String(opts.minScore));
  }
  if (opts.collection) {
    args.push("--collection", opts.collection);
  }

  let raw: string;
  try {
    raw = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      // Run from vault root so relative paths resolve correctly
      cwd: vaultRoot,
    });
  } catch (err: unknown) {
    // execFileSync throws if the child exits non-zero. For qmd query,
    // stderr gets the progress tree while stdout gets the JSON. Node
    // still throws if stderr was written to and the exit code was non-zero.
    // Try to recover the stdout from the error object.
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout: string | Buffer }).stdout;
      raw = typeof stdout === "string" ? stdout : stdout?.toString("utf-8") ?? "";
      if (!raw) return [];
    } else {
      return [];
    }
  }

  // Strip ANSI escape sequences (OSC, CSI, etc.) before parsing.
  // qmd query emits progress trees and terminal codes like \x1b]9;4;...
  // that can contain '[' characters that break naive JSON detection.
  const cleaned = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
                     .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Strip everything before the first JSON array '['.
  const jsonStart = cleaned.indexOf("[");
  if (jsonStart === -1) return [];
  const jsonText = cleaned.slice(jsonStart);

  let parsed: QmdRawResult[];
  try {
    parsed = JSON.parse(jsonText) as QmdRawResult[];
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((r) => r && typeof r.file === "string")
    .map((r) => {
      const absPath = resolveQmdUri(r.file, vaultRoot);
      // Extract collection name from qmd://collection/... URI
      const collection = extractCollection(r.file);
      return {
        path: absPath,
        score: typeof r.score === "number" ? r.score : 0,
        title: r.title ?? "",
        excerpt: r.snippet ?? "",
        collection,
      };
    });
}

function extractCollection(fileUri: string): string | undefined {
  const QMD_SCHEME = "qmd://";
  if (!fileUri.startsWith(QMD_SCHEME)) return undefined;
  const rest = fileUri.slice(QMD_SCHEME.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return rest || undefined;
  return rest.slice(0, slashIdx) || undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * BM25 keyword search — fast, no LLM, exact token matching.
 * Wraps `qmd search <query> --json`.
 */
export function qmdSearch(
  query: string,
  opts: QmdSearchOptions = {},
): QmdSearchResult[] {
  return runQmd("search", query, opts);
}

/**
 * Vector similarity search — embedding-based, finds semantically related
 * content even when keywords differ.
 * Wraps `qmd vsearch <query> --json`.
 */
export function qmdVectorSearch(
  query: string,
  opts: QmdSearchOptions = {},
): QmdSearchResult[] {
  return runQmd("vsearch", query, opts);
}

/**
 * Deep search — query expansion + reranking, highest recall and quality.
 * Best for "what do I know about X?" style queries.
 * Wraps `qmd query <query> --json`.
 */
export function qmdDeepSearch(
  query: string,
  opts: QmdSearchOptions = {},
): QmdSearchResult[] {
  return runQmd("query", query, opts);
}

/**
 * Check whether qmd is available on this system.
 */
export function isQmdAvailable(): boolean {
  return findQmdBinary() !== null;
}
