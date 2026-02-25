/**
 * test-architecture.ts
 *
 * Unit tests for shared architecture modules:
 * - queue-store.ts
 * - vault-conventions.ts
 * - frontmatter.ts
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PipelineQueueFile } from "../packages/architecture/src/domain.js";
import {
  lockPath,
  queuePath,
  readQueue,
  withQueueLock,
  writeQueue,
} from "../packages/architecture/src/queue-store.js";
import {
  commitmentMarkdownPath,
  commitmentLockPath,
  commitmentPath,
  withCommitmentLock,
  writeCommitmentsAtomic,
} from "../packages/architecture/src/commitment-store.js";
import {
  findFirstExistingPath,
  readFirstExisting,
  vaultPaths,
} from "../packages/architecture/src/vault-conventions.js";
import {
  extractFrontmatterBody,
  loadVocabulary,
  parseFrontmatter,
  parseTopicsFromFrontmatter,
} from "../packages/architecture/src/frontmatter.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${String(expected)}\nReceived: ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nReceived: ${actualJson}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createQueue(vaultRoot: string, taskId: string, phase = "surface"): PipelineQueueFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    lastUpdated: now,
    tasks: [
      {
        taskId,
        vaultId: vaultRoot,
        target: `Task ${taskId}`,
        sourcePath: `inbox/${taskId}.md`,
        phase: phase as "surface" | "reflect" | "revisit" | "verify",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

// ─── QueueStore tests ────────────────────────────────────────────────────────

function testQueueReadReturnsEmptyWhenMissing(): void {
  const vault = createTempDir("intent-architecture-queue-empty-");
  try {
    const queue = readQueue(vault);
    assertEqual(queue.version, 1, "readQueue should return canonical version");
    assertDeepEqual(queue.tasks, [], "readQueue should return empty tasks when queue file is missing");
    assert(typeof queue.lastUpdated === "string" && queue.lastUpdated.length > 0, "readQueue should set lastUpdated");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testQueueWriteReadRoundtripPreservesTasks(): void {
  const vault = createTempDir("intent-architecture-queue-roundtrip-");
  try {
    const queue = createQueue(vault, "task-roundtrip", "reflect");
    writeQueue(vault, queue);

    const loaded = readQueue(vault);
    assertEqual(loaded.tasks.length, 1, "roundtrip queue should keep exactly one task");
    assertEqual(loaded.tasks[0]?.taskId, "task-roundtrip", "roundtrip should preserve taskId");
    assertEqual(loaded.tasks[0]?.phase, "reflect", "roundtrip should preserve phase");
    assertEqual(loaded.tasks[0]?.sourcePath, "inbox/task-roundtrip.md", "roundtrip should preserve sourcePath");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testQueueWriteUsesAtomicRename(): Promise<void> {
  const vault = createTempDir("intent-architecture-queue-atomic-");
  try {
    const first = createQueue(vault, "task-a");
    const second = createQueue(vault, "task-b", "verify");

    const writeMany = async (queue: PipelineQueueFile, iterations: number): Promise<void> => {
      for (let i = 0; i < iterations; i += 1) {
        writeQueue(vault, queue);
        await sleep(0);
      }
    };

    await Promise.all([writeMany(first, 40), writeMany(second, 40)]);

    const raw = readFileSync(queuePath(vault), "utf-8");
    const parsed = JSON.parse(raw) as PipelineQueueFile;

    assert(Array.isArray(parsed.tasks), "queue file should remain valid JSON after interleaved writes");
    assertEqual(parsed.version, 1, "queue file should remain on canonical version after interleaved writes");

    const loaded = readQueue(vault);
    assertEqual(loaded.tasks.length, 1, "queue file should not be corrupted by interleaved writes");
    assert(
      loaded.tasks[0]?.taskId === "task-a" || loaded.tasks[0]?.taskId === "task-b",
      "queue file should contain one complete task payload",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testQueueLockPreventsConcurrentAccess(): Promise<void> {
  const vault = createTempDir("intent-architecture-queue-lock-wait-");
  try {
    let releaseFirst: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstEnteredAt = 0;
    let secondEnteredAt = 0;

    const first = withQueueLock(vault, async () => {
      firstEnteredAt = Date.now();
      await hold;
    });

    while (firstEnteredAt === 0) {
      await sleep(10);
    }

    const second = withQueueLock(vault, async () => {
      secondEnteredAt = Date.now();
    });

    await sleep(150);
    assertEqual(secondEnteredAt, 0, "second lock should wait until first lock is released");

    releaseFirst?.();
    await Promise.all([first, second]);

    assert(secondEnteredAt >= firstEnteredAt, "second lock should run after first lock begins");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testQueueLockCleansUpAfterSuccess(): Promise<void> {
  const vault = createTempDir("intent-architecture-queue-lock-success-");
  try {
    await withQueueLock(vault, async () => {
      writeQueue(vault, createQueue(vault, "task-success"));
    });

    assert(!existsSync(lockPath(vault)), "lock file should be removed after successful lock usage");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testQueueLockCleansUpAfterError(): Promise<void> {
  const vault = createTempDir("intent-architecture-queue-lock-error-");
  try {
    let threw = false;
    try {
      await withQueueLock(vault, async () => {
        throw new Error("lock fn failure");
      });
    } catch {
      threw = true;
    }

    assert(threw, "withQueueLock should rethrow function errors");
    assert(!existsSync(lockPath(vault)), "lock file should be removed even when function throws");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testQueueLockHandlesStaleLocks(): Promise<void> {
  const vault = createTempDir("intent-architecture-queue-lock-stale-");
  try {
    const staleLock = lockPath(vault);
    mkdirSync(join(vault, "ops", "queue"), { recursive: true });
    writeFileSync(staleLock, "stale lock", "utf-8");

    const staleTime = new Date(Date.now() - 35_000);
    utimesSync(staleLock, staleTime, staleTime);

    let entered = false;
    await withQueueLock(vault, async () => {
      entered = true;
    });

    assert(entered, "withQueueLock should recover and run when stale lock exists");
    assert(!existsSync(staleLock), "stale lock file should be cleaned after lock acquisition");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testCommitmentLockPreventsConcurrentAccess(): Promise<void> {
  const vault = createTempDir("intent-architecture-commitment-lock-wait-");
  try {
    let releaseFirst: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstEnteredAt = 0;
    let secondEnteredAt = 0;

    const first = withCommitmentLock(vault, async () => {
      firstEnteredAt = Date.now();
      await hold;
    });

    while (firstEnteredAt === 0) {
      await sleep(10);
    }

    const second = withCommitmentLock(vault, async () => {
      secondEnteredAt = Date.now();
    });

    await sleep(150);
    assertEqual(secondEnteredAt, 0, "second commitment lock should wait until first lock is released");

    releaseFirst?.();
    await Promise.all([first, second]);
    assert(secondEnteredAt >= firstEnteredAt, "second commitment lock should run after first lock begins");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testCommitmentLockHandlesStaleLocks(): Promise<void> {
  const vault = createTempDir("intent-architecture-commitment-lock-stale-");
  try {
    const staleLock = commitmentLockPath(vault);
    mkdirSync(join(vault, "ops"), { recursive: true });
    writeFileSync(staleLock, "stale lock", "utf-8");

    const staleTime = new Date(Date.now() - 35_000);
    utimesSync(staleLock, staleTime, staleTime);

    let entered = false;
    await withCommitmentLock(vault, async () => {
      entered = true;
    });

    assert(entered, "withCommitmentLock should recover and run when stale lock exists");
    assert(!existsSync(staleLock), "stale commitment lock file should be cleaned after lock acquisition");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testCommitmentsWriteUsesAtomicRename(): Promise<void> {
  const vault = createTempDir("intent-architecture-commitment-atomic-");
  try {
    const first = {
      version: 1,
      commitments: [{ id: "c1", label: "alpha", state: "active", priority: 1, horizon: "week" }],
      lastEvaluatedAt: new Date().toISOString(),
    };
    const second = {
      version: 1,
      commitments: [{ id: "c2", label: "beta", state: "active", priority: 2, horizon: "week" }],
      lastEvaluatedAt: new Date().toISOString(),
    };

    const writeMany = async (payload: unknown, iterations: number): Promise<void> => {
      for (let i = 0; i < iterations; i += 1) {
        writeCommitmentsAtomic(vault, payload);
        await sleep(0);
      }
    };

    await Promise.all([writeMany(first, 30), writeMany(second, 30)]);
    const parsed = JSON.parse(readFileSync(commitmentPath(vault), "utf-8")) as {
      version?: number;
      commitments?: unknown[];
    };
    assertEqual(parsed.version, 1, "commitments file should remain valid JSON after interleaved writes");
    assert(Array.isArray(parsed.commitments), "commitments file should retain commitments array");
    assert(
      (parsed.commitments ?? []).length === 1,
      "atomic commitment writes should preserve one complete payload",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testCommitmentWriteEnforcesIntegrityAndMirrorProjection(): void {
  const vault = createTempDir("intent-architecture-commitment-integrity-");
  try {
    const now = new Date().toISOString();
    writeCommitmentsAtomic(vault, {
      version: 1,
      commitments: [
        {
          id: "goal-thread-1",
          label: "Build Intent Computer",
          state: "active",
          priority: 1,
          horizon: "week",
          lastAdvancedAt: now,
          source: "test",
          evidence: [],
        },
        {
          id: "goal-thread-1",
          label: "Build Intent Computer",
          state: "active",
          priority: 2,
          horizon: "week",
          lastAdvancedAt: now,
          source: "test",
          evidence: [],
        },
      ],
      lastEvaluatedAt: now,
    });

    const parsed = JSON.parse(readFileSync(commitmentPath(vault), "utf-8")) as {
      commitments: Array<{ id: string }>;
    };
    assert(parsed.commitments.length === 2, "commitments write should preserve records");
    assert(
      parsed.commitments[0]?.id !== parsed.commitments[1]?.id,
      "integrity guard should prevent duplicate commitment IDs",
    );

    const mirrorPath = commitmentMarkdownPath(vault);
    assert(existsSync(mirrorPath), "commitment markdown mirror should be projected on write");
    const mirror = readFileSync(mirrorPath, "utf-8");
    assert(mirror.includes("| ID | Label | State |"), "markdown mirror should include commitment table");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testQueueReadNormalizesLegacySchema(): void {
  const vault = createTempDir("intent-architecture-queue-legacy-");
  try {
    mkdirSync(join(vault, "ops", "queue"), { recursive: true });
    writeFileSync(
      queuePath(vault),
      JSON.stringify(
        {
          schema_version: 3,
          tasks: [
            {
              id: "legacy-task-1",
              target: "Legacy Task",
              source: "inbox/legacy.md",
              type: "create",
              status: "pending",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const queue = readQueue(vault);
    assertEqual(queue.version, 1, "legacy queue should normalize to canonical version 1");
    assertEqual(queue.tasks.length, 1, "legacy queue should keep task entries after normalization");
    assertEqual(queue.tasks[0]?.taskId, "legacy-task-1", "legacy id should normalize to taskId");
    assertEqual(queue.tasks[0]?.phase, "surface", "legacy create phase should normalize to surface");
    assertEqual(queue.tasks[0]?.sourcePath, "inbox/legacy.md", "legacy source should normalize to sourcePath");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

// ─── VaultConventions tests ──────────────────────────────────────────────────

function testVaultPathsReturnsExpectedPaths(): void {
  const root = createTempDir("intent-architecture-vault-paths-");
  try {
    const paths = vaultPaths(root);
    assertEqual(paths.identity[0], join(root, "self", "identity.md"), "identity path[0] should match convention");
    assertEqual(paths.goals[1], join(root, "ops", "goals.md"), "goals path[1] should match convention");
    assertEqual(
      paths.workingMemory[0],
      join(root, "self", "working-memory.md"),
      "working memory path[0] should match convention",
    );
    assertEqual(paths.queue[0], join(root, "ops", "queue", "queue.json"), "queue path should match convention");
    assertEqual(paths.inbox, join(root, "inbox"), "inbox path should match convention");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testReadFirstExistingReturnsFirstContent(): void {
  const root = createTempDir("intent-architecture-vault-read-first-");
  try {
    const first = join(root, "first.md");
    const second = join(root, "second.md");
    writeFileSync(first, "first content", "utf-8");
    writeFileSync(second, "second content", "utf-8");

    const value = readFirstExisting([first, second]);
    assertEqual(value, "first content", "readFirstExisting should return content from first existing file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testReadFirstExistingReturnsNullWhenMissing(): void {
  const root = createTempDir("intent-architecture-vault-read-null-");
  try {
    const value = readFirstExisting([join(root, "missing-a.md"), join(root, "missing-b.md")]);
    assertEqual(value, null, "readFirstExisting should return null when no files exist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testReadFirstExistingSkipsMissingAndFindsLater(): void {
  const root = createTempDir("intent-architecture-vault-read-skip-");
  try {
    const later = join(root, "later.md");
    writeFileSync(later, "later content", "utf-8");

    const value = readFirstExisting([join(root, "missing.md"), later]);
    assertEqual(value, "later content", "readFirstExisting should skip missing files and return later candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testFindFirstExistingPathReturnsPath(): void {
  const root = createTempDir("intent-architecture-vault-find-path-");
  try {
    const first = join(root, "first.md");
    const second = join(root, "second.md");
    writeFileSync(first, "first content", "utf-8");
    writeFileSync(second, "second content", "utf-8");

    const found = findFirstExistingPath([join(root, "missing.md"), first, second]);
    assertEqual(found, first, "findFirstExistingPath should return first existing path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testFindFirstExistingPathReturnsNullWhenMissing(): void {
  const root = createTempDir("intent-architecture-vault-find-null-");
  try {
    const found = findFirstExistingPath([join(root, "missing-a.md"), join(root, "missing-b.md")]);
    assertEqual(found, null, "findFirstExistingPath should return null when no files exist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Frontmatter tests ───────────────────────────────────────────────────────

function testParseFrontmatterExtractsKeyValues(): void {
  const content = `---
title: Intent Computer
description: shared architecture
---
Body`;
  const parsed = parseFrontmatter(content);
  assertDeepEqual(
    parsed,
    {
      title: "Intent Computer",
      description: "shared architecture",
    },
    "parseFrontmatter should parse scalar key/value pairs",
  );
}

function testParseFrontmatterQuotedValues(): void {
  const content = `---
single: 'single value'
double: "double value"
---
Body`;
  const parsed = parseFrontmatter(content);
  assertEqual(parsed.single, "single value", "parseFrontmatter should parse single-quoted strings");
  assertEqual(parsed.double, "double value", "parseFrontmatter should parse double-quoted strings");
}

function testParseFrontmatterArrayValues(): void {
  const content = `---
topics: ["[[alpha]]", '[[beta]]', gamma]
---
Body`;
  const parsed = parseFrontmatter(content);
  assertDeepEqual(
    parsed.topics,
    ["[[alpha]]", "[[beta]]", "gamma"],
    "parseFrontmatter should parse bracket-array values",
  );
}

function testParseFrontmatterWithoutFrontmatter(): void {
  const parsed = parseFrontmatter("# No frontmatter");
  assertDeepEqual(parsed, {}, "parseFrontmatter should return empty object when frontmatter is missing");
}

function testParseFrontmatterUnclosedFrontmatter(): void {
  const parsed = parseFrontmatter(`---
title: missing close`);
  assertDeepEqual(parsed, {}, "parseFrontmatter should return empty object when frontmatter is unclosed");
}

function testExtractFrontmatterBodyAfterClosingMarker(): void {
  const content = `---
title: test
---

Hello world`;
  const body = extractFrontmatterBody(content);
  assertEqual(body, "Hello world", "extractFrontmatterBody should return content after closing marker");
}

function testExtractFrontmatterBodyWithoutFrontmatter(): void {
  const content = "Plain content with no frontmatter";
  const body = extractFrontmatterBody(content);
  assertEqual(body, content, "extractFrontmatterBody should return full content when no frontmatter exists");
}

function testParseTopicsBracketStyle(): void {
  const content = `---
topics: ["[[topic-a]]", "[[topic-b]]"]
---
Body`;
  const topics = parseTopicsFromFrontmatter(content);
  assertDeepEqual(
    topics,
    ["[[topic-a]]", "[[topic-b]]"],
    "parseTopicsFromFrontmatter should parse bracket-style topics",
  );
}

function testParseTopicsListStyle(): void {
  const content = `---
topics:
  - "[[topic-a]]"
  - '[[topic-b]]'
---
Body`;
  const topics = parseTopicsFromFrontmatter(content);
  assertDeepEqual(
    topics,
    ["[[topic-a]]", "[[topic-b]]"],
    "parseTopicsFromFrontmatter should parse list-style topics",
  );
}

function testParseTopicsMissingTopicsField(): void {
  const content = `---
title: no topics here
---
Body`;
  const topics = parseTopicsFromFrontmatter(content);
  assertDeepEqual(topics, [], "parseTopicsFromFrontmatter should return empty array when topics field is missing");
}

function testLoadVocabularyExtractsSection(): void {
  const content = `---
title: manifest
vocabulary:
  inbox: "inbox"
  cmd_reflect: "/reflect"
---
Body`;
  const vocabulary = loadVocabulary(content);
  assertDeepEqual(
    vocabulary,
    { inbox: "inbox", cmd_reflect: "reflect" },
    "loadVocabulary should extract vocabulary mapping from frontmatter",
  );
}

function testLoadVocabularyMissingSectionReturnsEmpty(): void {
  const content = `---
title: manifest
---
Body`;
  const vocabulary = loadVocabulary(content);
  assertDeepEqual(vocabulary, {}, "loadVocabulary should return empty object when section is missing");
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: "QueueStore: readQueue returns empty queue when file missing", run: testQueueReadReturnsEmptyWhenMissing },
    { name: "QueueStore: writeQueue/readQueue roundtrip preserves tasks", run: testQueueWriteReadRoundtripPreservesTasks },
    { name: "QueueStore: writeQueue uses atomic rename under interleaved writes", run: testQueueWriteUsesAtomicRename },
    { name: "QueueStore: withQueueLock prevents concurrent access", run: testQueueLockPreventsConcurrentAccess },
    { name: "QueueStore: withQueueLock cleans lock file after success", run: testQueueLockCleansUpAfterSuccess },
    { name: "QueueStore: withQueueLock cleans lock file after error", run: testQueueLockCleansUpAfterError },
    { name: "QueueStore: withQueueLock handles stale locks", run: testQueueLockHandlesStaleLocks },
    { name: "QueueStore: readQueue normalizes legacy schema_version=3", run: testQueueReadNormalizesLegacySchema },
    { name: "CommitmentStore: withCommitmentLock prevents concurrent access", run: testCommitmentLockPreventsConcurrentAccess },
    { name: "CommitmentStore: withCommitmentLock handles stale locks", run: testCommitmentLockHandlesStaleLocks },
    { name: "CommitmentStore: writeCommitmentsAtomic uses atomic rename under interleaved writes", run: testCommitmentsWriteUsesAtomicRename },
    { name: "CommitmentStore: writeCommitmentsAtomic enforces unique IDs and markdown mirror", run: testCommitmentWriteEnforcesIntegrityAndMirrorProjection },
    { name: "VaultConventions: vaultPaths returns expected paths", run: testVaultPathsReturnsExpectedPaths },
    { name: "VaultConventions: readFirstExisting returns first content", run: testReadFirstExistingReturnsFirstContent },
    { name: "VaultConventions: readFirstExisting returns null when none exist", run: testReadFirstExistingReturnsNullWhenMissing },
    { name: "VaultConventions: readFirstExisting skips missing and finds later", run: testReadFirstExistingSkipsMissingAndFindsLater },
    { name: "VaultConventions: findFirstExistingPath returns first path", run: testFindFirstExistingPathReturnsPath },
    { name: "VaultConventions: findFirstExistingPath returns null when none exist", run: testFindFirstExistingPathReturnsNullWhenMissing },
    { name: "Frontmatter: parseFrontmatter extracts key/value pairs", run: testParseFrontmatterExtractsKeyValues },
    { name: "Frontmatter: parseFrontmatter handles quoted values", run: testParseFrontmatterQuotedValues },
    { name: "Frontmatter: parseFrontmatter handles array bracket values", run: testParseFrontmatterArrayValues },
    { name: "Frontmatter: parseFrontmatter without frontmatter returns {}", run: testParseFrontmatterWithoutFrontmatter },
    { name: "Frontmatter: parseFrontmatter with unclosed frontmatter returns {}", run: testParseFrontmatterUnclosedFrontmatter },
    { name: "Frontmatter: extractFrontmatterBody returns content after frontmatter", run: testExtractFrontmatterBodyAfterClosingMarker },
    { name: "Frontmatter: extractFrontmatterBody returns full content without frontmatter", run: testExtractFrontmatterBodyWithoutFrontmatter },
    { name: "Frontmatter: parseTopicsFromFrontmatter parses bracket-style topics", run: testParseTopicsBracketStyle },
    { name: "Frontmatter: parseTopicsFromFrontmatter parses list-style topics", run: testParseTopicsListStyle },
    { name: "Frontmatter: parseTopicsFromFrontmatter returns [] when topics missing", run: testParseTopicsMissingTopicsField },
    { name: "Frontmatter: loadVocabulary extracts vocabulary section", run: testLoadVocabularyExtractsSection },
    { name: "Frontmatter: loadVocabulary returns {} when vocabulary missing", run: testLoadVocabularyMissingSectionReturnsEmpty },
  ];

  let passed = 0;

  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`PASS: ${test.name}`);
    } catch (error) {
      console.error(`FAIL: ${test.name}`);
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  }

  console.log(`\nArchitecture module checks passed: ${passed}/${tests.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
