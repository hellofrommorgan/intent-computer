import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 30_000;

export function commitmentPath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "commitments.json");
}

export function commitmentMarkdownPath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "commitments.md");
}

export function commitmentLockPath(vaultRoot: string): string {
  return join(vaultRoot, "ops", "commitments.lock");
}

export function normalizeCommitmentLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveCommitmentId(label: string): string {
  const normalized = normalizeCommitmentLabel(label)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `goal-${normalized || "untitled"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function enforceCommitmentIntegrity<T extends { id?: string; label?: string }>(
  commitments: T[],
): T[] {
  const usedIds = new Set<string>();
  const baseCounts = new Map<string, number>();

  return commitments.map((commitment, index) => {
    const label = typeof commitment.label === "string" ? commitment.label : "";
    const fallbackSeed = label || commitment.id || `commitment-${index + 1}`;
    const baseId = deriveCommitmentId(fallbackSeed);
    const seen = baseCounts.get(baseId) ?? 0;
    baseCounts.set(baseId, seen + 1);

    let candidate = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
    while (usedIds.has(candidate)) {
      const collisionCount = (baseCounts.get(baseId) ?? seen + 1) + 1;
      baseCounts.set(baseId, collisionCount);
      candidate = `${baseId}-${collisionCount}`;
    }
    usedIds.add(candidate);

    return {
      ...commitment,
      id: candidate,
    };
  });
}

function normalizeCommitmentPayload(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const commitments = data.commitments;
  if (!Array.isArray(commitments)) return data;
  const rows = commitments.filter((entry): entry is { id?: string; label?: string } => isRecord(entry));
  if (rows.length !== commitments.length) return data;
  const normalized = enforceCommitmentIntegrity(rows);
  return {
    ...data,
    commitments: normalized,
  };
}

function renderCommitmentsMarkdown(data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data.commitments)) return null;
  const rows = data.commitments.filter(isRecord);
  const generatedAt =
    typeof data.lastEvaluatedAt === "string" && data.lastEvaluatedAt
      ? data.lastEvaluatedAt
      : new Date().toISOString();

  const lines: string[] = [
    "# Commitments",
    "",
    `Generated: ${generatedAt}`,
    "",
    "| ID | Label | State | Priority | Horizon | Desire | Friction | Last Advanced |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const label = typeof row.label === "string" ? row.label : "";
    const state = typeof row.state === "string" ? row.state : "";
    const priority = typeof row.priority === "number" ? String(row.priority) : "";
    const horizon = typeof row.horizon === "string" ? row.horizon : "";
    const desire = typeof row.desireClass === "string" ? row.desireClass : "unknown";
    const friction = typeof row.frictionClass === "string" ? row.frictionClass : "unknown";
    const lastAdvancedAt = typeof row.lastAdvancedAt === "string" ? row.lastAdvancedAt : "";
    lines.push(
      `| ${id} | ${label.replace(/\|/g, "\\|")} | ${state} | ${priority} | ${horizon} | ${desire} | ${friction} | ${lastAdvancedAt} |`,
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

export interface CommitmentWriteOptions {
  writeMarkdownMirror?: boolean;
}

export async function withCommitmentLock<T>(
  vaultRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = commitmentLockPath(vaultRoot);
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
    throw new Error("Failed to acquire commitment lock");
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

export function writeCommitmentsAtomic(
  vaultRoot: string,
  data: unknown,
  options: CommitmentWriteOptions = {},
): void {
  const normalizedData = normalizeCommitmentPayload(data);
  const path = commitmentPath(vaultRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(normalizedData, null, 2), "utf-8");
  renameSync(tmpPath, path);

  if (options.writeMarkdownMirror ?? true) {
    const markdown = renderCommitmentsMarkdown(normalizedData);
    if (markdown) {
      const mdPath = commitmentMarkdownPath(vaultRoot);
      const mdTmpPath = `${mdPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(mdTmpPath, markdown, "utf-8");
      renameSync(mdTmpPath, mdPath);
    }
  }
}
