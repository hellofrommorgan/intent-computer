/**
 * cursor-store.ts — Attentional memory for perception feeds
 *
 * Cursors track what the agent has already perceived from each source.
 * Stored at ops/runtime/perception-cursors.json (runtime state, not knowledge).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import type { CursorStoreData, SourceCursor } from "@intent-computer/architecture";

const CURSOR_FILE = "ops/runtime/perception-cursors.json";

function emptyCursorStore(): CursorStoreData {
  return { cursors: {}, lastUpdated: new Date().toISOString() };
}

/**
 * Read the cursor store from disk. Returns an empty store if the file
 * doesn't exist or is malformed.
 */
export function readCursors(vaultRoot: string): CursorStoreData {
  const filePath = join(vaultRoot, CURSOR_FILE);
  if (!existsSync(filePath)) {
    return emptyCursorStore();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CursorStoreData;
    if (!parsed.cursors || typeof parsed.cursors !== "object") {
      return emptyCursorStore();
    }
    return parsed;
  } catch {
    return emptyCursorStore();
  }
}

/**
 * Write the cursor store atomically (write to .tmp, then rename).
 * Creates the ops/runtime/ directory if it doesn't exist.
 */
export function writeCursors(vaultRoot: string, store: CursorStoreData): void {
  const filePath = join(vaultRoot, CURSOR_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Get the cursor for a specific source. Returns undefined if no cursor exists.
 */
export function getCursor(
  store: CursorStoreData,
  sourceId: string,
): SourceCursor | undefined {
  return store.cursors[sourceId];
}

/**
 * Return a new store with the given source's cursor updated.
 * Also bumps lastUpdated to now.
 */
export function updateCursor(
  store: CursorStoreData,
  sourceId: string,
  cursor: SourceCursor,
): CursorStoreData {
  return {
    cursors: { ...store.cursors, [sourceId]: cursor },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * For id-set cursors, trim seenIds to maxRetained entries (keeping the most
 * recent, i.e. the tail of the array). Other cursor types pass through unchanged.
 */
export function pruneCursor(cursor: SourceCursor): SourceCursor {
  if (cursor.type !== "id-set") {
    return cursor;
  }
  if (cursor.seenIds.length <= cursor.maxRetained) {
    return cursor;
  }
  return {
    ...cursor,
    seenIds: cursor.seenIds.slice(-cursor.maxRetained),
  };
}
