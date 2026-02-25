import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { PipelineQueueFile } from "./domain.js";
import { normalizeQueueFile } from "./queue.js";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 30_000;

export function queuePath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "queue", "queue.json");
}

export function lockPath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "queue", "queue.lock");
}

export async function withQueueLock<T>(
  vaultRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = lockPath(vaultRoot);
  const dir = dirname(lock);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (Date.now() < deadline) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  if (fd === null) {
    try {
      const stat = statSync(lock);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lock);
        fd = openSync(lock, "wx");
      }
    } catch {
      // Ignore stale lock recovery failures and throw below if still locked.
    }
  }

  if (fd === null) {
    throw new Error("Failed to acquire queue lock");
  }

  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort lock fd cleanup.
    }
    try {
      unlinkSync(lock);
    } catch {
      // Best-effort lock file cleanup.
    }
  }
}

export function readQueue(vaultRoot: string): PipelineQueueFile {
  const path = queuePath(vaultRoot);
  if (!existsSync(path)) {
    return {
      version: 1,
      tasks: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeQueueFile(raw, vaultRoot);
  } catch {
    return {
      version: 1,
      tasks: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}

export function writeQueue(vaultRoot: string, queue: PipelineQueueFile): void {
  const path = queuePath(vaultRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        version: 1,
        lastUpdated: queue.lastUpdated,
        tasks: queue.tasks,
      },
      null,
      2,
    ),
    "utf-8",
  );
  renameSync(tmpPath, path);
}
