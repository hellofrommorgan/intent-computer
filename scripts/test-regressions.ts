/**
 * test-regressions.ts
 *
 * Focused regression checks for critical adapter/runtime bugs:
 * - shell injection paths in MCP adapter
 * - thoughtId traversal protections
 * - thought write/read identifier consistency
 * - topic frontmatter parsing for wiki links
 * - stable proposition IDs in memory hydration
 * - revisit -> reweave phase mapping in LocalPipelineAdapter
 * - heartbeat queue schema compatibility for task IDs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanVaultGraph } from "../packages/architecture/src/index.js";
import { LocalMcpAdapter } from "../packages/mcp-server/src/local-adapter.js";
import { LocalMemoryAdapter } from "../packages/plugin/src/adapters/local-memory.js";
import { LocalPipelineAdapter } from "../packages/plugin/src/adapters/local-pipeline.js";
import { writeValidate } from "../packages/plugin/src/hooks/write-validate.js";
import { forkSkill } from "../packages/plugin/src/skills/fork.js";
import { buildHelpText } from "../packages/plugin/src/skills/help.js";
import { createRouter } from "../packages/plugin/src/skills/router.js";
import { findAlignedTasks } from "../packages/heartbeat/src/heartbeat.js";
import {
  detectCapturableInsights,
  isDuplicateCapture,
  parseTranscriptLines,
  extractRecentAssistantText,
  normalizeForComparison,
  slugify,
} from "../packages/plugin/src/adapters/claude-code/capture-heuristic.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function createTempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "intent-computer-regressions-"));
  mkdirSync(join(vault, "thoughts"), { recursive: true });
  mkdirSync(join(vault, "self"), { recursive: true });
  mkdirSync(join(vault, "ops", "queue"), { recursive: true });
  mkdirSync(join(vault, "ops", "queue", "archive"), { recursive: true });
  mkdirSync(join(vault, "ops"), { recursive: true });
  mkdirSync(join(vault, "inbox"), { recursive: true });
  return vault;
}

function writeThought(
  vault: string,
  thoughtId: string,
  opts: { topics?: string; body?: string; description?: string } = {},
): void {
  const content = `---
description: "${opts.description ?? "test"}"
topics: ${opts.topics ?? "[]"}
created: "2026-02-19"
---

${opts.body ?? "body"}
`;
  writeFileSync(join(vault, "thoughts", `${thoughtId}.md`), content, "utf-8");
}

function makeIntentContext(vault: string) {
  const now = new Date().toISOString();
  return {
    session: {
      sessionId: "s1",
      actorId: "test-user",
      startedAt: now,
      worktree: vault,
    },
    intent: {
      id: "i1",
      actorId: "test-user",
      statement: "regression test",
      source: "explicit" as const,
      requestedAt: now,
    },
    perception: { observedAt: now, signals: [], gaps: [] },
    identity: {
      actorId: "test-user",
      selfModel: "",
      umwelt: [],
      priorities: [],
      commitments: [],
      updatedAt: now,
    },
    commitment: {
      intentId: "i1",
      activeCommitments: [],
      protectedGaps: [],
      compressedGaps: [],
      rationale: "",
      updatedAt: now,
    },
  };
}

async function testThoughtPathGuardsAndConsistency(): Promise<void> {
  const vault = createTempVault();
  try {
    const adapter = new LocalMcpAdapter(vault);

    mkdirSync(join(vault, "ops"), { recursive: true });
    writeFileSync(join(vault, "ops", "secret.md"), "sensitive", "utf-8");

    const traversalGet = await adapter.thoughtGet({
      vaultId: "local",
      thoughtId: "../../ops/secret",
    });
    assert(traversalGet === null, "thought_get should reject traversal ids");

    const traversalGraph = await adapter.linkGraph({
      vaultId: "local",
      thoughtId: "../../ops/secret",
    });
    assert(
      traversalGraph.edges.length === 0,
      "link_graph should reject traversal ids",
    );

    const written = await adapter.thoughtWrite({
      vaultId: "local",
      proposition: {
        id: "external-id",
        vaultId: "local",
        title: "Hello World",
        description: "Write/read consistency test",
        topics: ["[[testing]]"],
        createdAt: "2026-02-19",
        updatedAt: "2026-02-19",
      },
      markdown: "content",
    });

    assert(
      written.thoughtId === "hello-world" || written.thoughtId === "hello world",
      `thought_write should return slug thoughtId, got "${written.thoughtId}"`,
    );

    const readBack = await adapter.thoughtGet({
      vaultId: "local",
      thoughtId: written.thoughtId,
    });
    assert(readBack !== null, "thought_get should load thought_write output");
    assert(
      readBack?.id === "hello-world" || readBack?.id === "hello world",
      "read-back proposition id should match stored thought id",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testThoughtSearchNoShellInjection(): Promise<void> {
  const vault = createTempVault();
  try {
    writeThought(vault, "safe-note", { body: "ordinary content" });

    const adapter = new LocalMcpAdapter(vault);
    const sentinel = join(vault, "ops", "injected.txt");
    const payload = `" && touch ${sentinel} && echo "`;

    await adapter.thoughtSearch({
      vaultId: "local",
      query: payload,
      limit: 10,
    });

    assert(
      !existsSync(sentinel),
      "thought_search query must not execute shell payloads",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testTopicsParserWithWikiLinks(): Promise<void> {
  const vault = createTempVault();
  try {
    writeThought(vault, "topic-test", {
      topics: `["[[topic-a]]", "[[topic-b]]"]`,
      description: "topic parser test",
    });

    const adapter = new LocalMcpAdapter(vault);
    const thought = await adapter.thoughtGet({
      vaultId: "local",
      thoughtId: "topic-test",
    });

    assert(thought !== null, "thought_get should find topic-test");
    assert(
      thought?.topics.length === 2,
      `expected 2 topics, got ${thought?.topics.length ?? 0}`,
    );
    assert(
      thought?.topics[0] === "[[topic-a]]" && thought?.topics[1] === "[[topic-b]]",
      `unexpected topics payload: ${JSON.stringify(thought?.topics ?? [])}`,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testMemoryStablePropositionIds(): Promise<void> {
  const vault = createTempVault();
  try {
    writeThought(vault, "stable-note", {
      topics: `["[[memory]]"]`,
      body: "stable identity across hydrate calls",
      description: "memory id stability",
    });

    const memory = new LocalMemoryAdapter(vault);
    const context = makeIntentContext(vault);

    const first = await memory.hydrate(context);
    const second = await memory.hydrate(context);

    const firstProp = first.propositions.find((p) => p.title === "stable-note");
    const secondProp = second.propositions.find((p) => p.title === "stable-note");

    assert(firstProp !== undefined, "first hydrate should include stable-note");
    assert(secondProp !== undefined, "second hydrate should include stable-note");
    assert(
      firstProp?.id === "stable-note",
      `expected deterministic id "stable-note", got "${firstProp?.id}"`,
    );
    assert(
      firstProp?.id === secondProp?.id,
      "proposition id should remain stable across hydration runs",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testLocalPipelineRevisitAlias(): Promise<void> {
  const vault = createTempVault();
  try {
    const sourcePath = join(vault, "inbox", "pipeline-source.md");
    writeFileSync(sourcePath, "source content", "utf-8");

    const client = {
      session: {
        create: async () => ({ data: { id: "regression-session" } }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: "phase complete" }] },
        }),
        delete: async () => ({ data: {} }),
      },
    };

    const pipeline = new LocalPipelineAdapter(vault, client, {});
    const result = await pipeline.runPhase(
      {
        taskId: "task-1",
        vaultId: vault,
        target: "pipeline-source",
        sourcePath,
        phase: "revisit",
      },
      "revisit",
    );

    assert(
      result.success,
      `revisit phase should resolve to a runnable skill, got: ${result.summary}`,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testHeartbeatQueueTaskIdCompatibility(): void {
  const vault = createTempVault();
  try {
    const now = new Date().toISOString();

    writeFileSync(
      join(vault, "ops", "commitments.json"),
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "c1",
              label: "vector",
              state: "active",
              priority: 1,
              horizon: "week",
              source: "test",
              lastAdvancedAt: now,
              evidence: [],
            },
          ],
          lastEvaluatedAt: now,
        },
        null,
        2,
      ),
      "utf-8",
    );

    writeFileSync(
      join(vault, "ops", "queue", "queue.json"),
      JSON.stringify(
        {
          tasks: [
            {
              taskId: "task-123",
              target: "Vector indexing cleanup",
              sourcePath: "inbox/vector.md",
              phase: "reflect",
              createdAt: now,
            },
          ],
          lastUpdated: now,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const aligned = findAlignedTasks(vault);
    assert(aligned.triggered === 1, "heartbeat should detect aligned queue task");
    assert(
      aligned.tasks[0]?.taskId === "task-123",
      "heartbeat should preserve taskId from queue schema",
    );
    assert(
      aligned.tasks[0]?.target === "Vector indexing cleanup",
      "heartbeat should preserve original target casing",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testRuntimeMcpBoundaryPreserved(): void {
  const guardedFiles = [
    join(process.cwd(), "packages/plugin/src/index.ts"),
    join(process.cwd(), "packages/heartbeat/src/index.ts"),
    join(process.cwd(), "packages/heartbeat/src/heartbeat.ts"),
    join(process.cwd(), "packages/architecture/src/holistic-runtime.ts"),
  ];
  const forbiddenPatterns = [
    /@intent-computer\/mcp-server/,
    /packages\/mcp-server\/src\/server/,
    /mcp-server\/src\/server/,
  ];

  for (const file of guardedFiles) {
    const content = readFileSync(file, "utf-8");
    for (const pattern of forbiddenPatterns) {
      assert(
        !pattern.test(content),
        `active runtime file must not reference MCP server entrypoint (${pattern}) in ${file}`,
      );
    }
  }
}

function testProcessInboxQueueFirstDispatchContract(): void {
  const indexPath = join(process.cwd(), "packages/plugin/src/index.ts");
  const content = readFileSync(indexPath, "utf-8");
  assert(
    !content.includes("runPipeline("),
    "process-inbox dispatch should not use direct runPipeline execution path",
  );
  assert(
    content.includes("seedInboxSourceIntoQueue"),
    "process-inbox dispatch should seed inbox items into queue before /process execution",
  );
}

async function testProcessCommandContract(): Promise<void> {
  const vault = createTempVault();
  try {
    const router = await createRouter(vault);
    assert(router.detect("/process 2") === "process", "router should accept /process command");
    assert(router.detect("/pipeline source.md") === null, "router should reject deprecated /pipeline command");
    assert(router.detect("/ralph 2") === null, "router should reject deprecated /ralph command");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testHelpListsProcessOnly(): Promise<void> {
  const vault = createTempVault();
  try {
    const help = await buildHelpText(vault);
    assert(help.includes("/process [N]"), "help should include /process");
    assert(!help.includes("/pipeline"), "help should not include deprecated /pipeline");
    assert(!help.includes("/ralph"), "help should not include deprecated /ralph");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testForkTimeoutHardening(): Promise<void> {
  const vault = createTempVault();
  try {
    let deleted = false;
    const client = {
      session: {
        create: async () => ({ data: { id: "timeout-session" } }),
        prompt: async () => new Promise(() => { }),
        delete: async () => {
          deleted = true;
          return { data: {} };
        },
      },
    };

    const start = Date.now();
    const result = await forkSkill(
      {
        skillName: "reduce",
        skillInstructions: "Do nothing.",
        taskContext: "task",
        vaultRoot: vault,
        timeoutMs: 50,
      },
      client as any,
      {} as any,
    );
    const elapsed = Date.now() - start;

    assert(!result.success, "timed out fork should return success=false");
    assert(result.error?.includes("timed out"), "timed out fork should return deterministic timeout error");
    assert(elapsed < 1000, `timed out fork should fail quickly, elapsed=${elapsed}ms`);
    assert(deleted, "timed out fork should attempt session cleanup");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testSourcePathLinksIgnoredForDanglingWikiChecks(): void {
  const vault = createTempVault();
  try {
    writeThought(vault, "link-target", { body: "target body" });
    writeThought(vault, "source-note", {
      body: [
        "Source: [article](ops/queue/archive/2026-02-20/article.md)",
        "Related: [[link-target]]",
      ].join("\n"),
    });

    const graph = scanVaultGraph(vault, {
      entityDirs: ["thoughts", "self"],
      excludeCodeBlocks: true,
    });
    assert(graph.danglingCount === 0, `path Source link should not count as dangling wiki link (got ${graph.danglingCount})`);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testGraphScanExcludesCodeBlockExamples(): void {
  const vault = createTempVault();
  try {
    writeThought(vault, "alpha", {
      body: [
        "```md",
        "[[missing-note]]",
        "```",
      ].join("\n"),
    });
    writeThought(vault, "beta", { body: "Connects to [[alpha]]" });
    writeThought(vault, "gamma", { body: "standalone" });

    const graph = scanVaultGraph(vault, {
      entityDirs: ["thoughts", "self"],
      excludeCodeBlocks: true,
    });
    assert(graph.danglingCount === 0, "wiki links in fenced code blocks should be excluded from dangling checks");
    assert(graph.orphanCount >= 2, "graph scan should report orphan entities with shared scope");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

async function testWriteValidateWarnsOnNonKebabFileName(): Promise<void> {
  const vault = createTempVault();
  try {
    // Use a kebab-case filename — write-validate warns when a vault file IS kebab-case,
    // since vault convention is prose-with-spaces.
    const path = join(vault, "thoughts", "mixed-case-title.md");
    writeFileSync(
      path,
      `---\ndescription: \"desc long enough for validation\"\ntopics: [\"[[topic]]\"]\n---\n\nbody\n`,
      "utf-8",
    );

    const warning = await writeValidate(path);
    assert(warning?.includes("kebab-case"), "write validation should warn on kebab-case filenames");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

// ─── Stop-capture heuristic tests ────────────────────────────────────────────

function testDetectCapturableInsightsStrongSignal(): void {
  const text = "After investigating, the root cause is that the retry logic fires before token propagation completes. This breaks all downstream auth checks.";
  const captures = detectCapturableInsights(text);
  assert(captures.length > 0, "strong-signal phrase should produce at least one capture");
  assert(
    captures.some((c) => c.confidence >= 1 && c.claim.length > 10),
    "capture should have claim with sufficient length",
  );
}

function testDetectCapturableInsightsNoiseRejection(): void {
  // Vague/generic text that should not trigger capture
  const text = "Let me look at the code and see what's going on. I'll check the files now.";
  const captures = detectCapturableInsights(text);
  assert(captures.length === 0, "generic assistant chatter should not produce captures");
}

function testDetectCapturableInsightsShortTextRejected(): void {
  const text = "OK";
  const captures = detectCapturableInsights(text);
  assert(captures.length === 0, "text too short to contain meaningful insights should return empty");
}

function testExtractRecentAssistantTextFiltersUserMessages(): void {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "What is the root cause?" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The root cause is that the cache is not invalidated on write." }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "internal thinking" }, { type: "text", text: "So the fix is to clear the cache after each write." }] } }),
  ];
  const entries = parseTranscriptLines(lines);
  const text = extractRecentAssistantText(entries, 5);
  assert(!text.includes("What is the root cause?"), "user messages should be excluded from extracted text");
  assert(text.includes("root cause"), "assistant text should be included");
  assert(!text.includes("internal thinking"), "thinking blocks should not appear in text");
}

function testParseTranscriptLinesSkipsMalformed(): void {
  const lines = [
    "not json at all",
    JSON.stringify({ type: "file-history-snapshot", messageId: "x" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "real content" } }),
    "",
    "{ broken",
  ];
  const entries = parseTranscriptLines(lines);
  assert(entries.length === 1, "should parse exactly one valid assistant entry from mixed input");
  assert(entries[0]?.type === "assistant", "parsed entry should be the assistant message");
}

function testIsDuplicateCaptureDetectsHighOverlap(): void {
  const dir = mkdtempSync(join(tmpdir(), "intent-dedup-"));
  try {
    const claim = "the retry logic fires before token propagation";
    writeFileSync(
      join(dir, "existing.md"),
      `---\ntitle: "the retry logic fires before token propagation"\nsource: "session-capture"\n---\n\nsome context\n`,
      "utf-8",
    );
    assert(isDuplicateCapture(claim, dir), "identical claim should be flagged as duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testIsDuplicateCaptureAllowsDistinctClaims(): void {
  const dir = mkdtempSync(join(tmpdir(), "intent-dedup-distinct-"));
  try {
    writeFileSync(
      join(dir, "existing.md"),
      `---\ntitle: "the cache is not invalidated on write"\nsource: "session-capture"\n---\n\ncontext\n`,
      "utf-8",
    );
    assert(
      !isDuplicateCapture("the retry logic fires before token propagation", dir),
      "distinct claims should not be flagged as duplicates",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testIsDuplicateCaptureHandlesMissingInbox(): void {
  const result = isDuplicateCapture("some claim here", "/nonexistent/path/inbox");
  assert(!result, "missing inbox directory should be treated as no duplicates");
}

function testNormalizeForComparisonStripsSpecialChars(): void {
  const raw = "The fix is: call `flush()` before exit!";
  const normalized = normalizeForComparison(raw);
  assert(!normalized.includes(":"), "normalized string should not contain colons");
  assert(!normalized.includes("`"), "normalized string should not contain backticks");
  assert(normalized.length <= 60, "normalized string should be capped at 60 chars");
}

function testSlugifyProducesKebabCase(): void {
  const claim = "the retry logic fires before token propagation";
  const slug = slugify(claim);
  assert(/^[a-z0-9-]+$/.test(slug), "slug should only contain lowercase letters, numbers, and hyphens");
  assert(!slug.startsWith("-") && !slug.endsWith("-"), "slug should not start or end with hyphens");
  assert(slug.length <= 60, "slug should be capped at 60 chars");
}

function testStopCaptureHookRegistered(): void {
  // Verify the install.ts config includes the Stop hook pointing to stop-capture.ts
  const installPath = join(process.cwd(), "packages/plugin/src/adapters/claude-code/install.ts");
  const content = readFileSync(installPath, "utf-8");
  assert(content.includes("stop-capture.ts"), "install.ts should register stop-capture.ts as a Stop hook");
  assert(content.includes("Stop:"), "install.ts hooks config should include Stop event key");
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: "process command contract", run: testProcessCommandContract },
    { name: "help lists process only", run: testHelpListsProcessOnly },
    { name: "process-inbox queue-first dispatch contract", run: testProcessInboxQueueFirstDispatchContract },
    { name: "thought path guards + write/read consistency", run: testThoughtPathGuardsAndConsistency },
    { name: "thought_search shell injection guard", run: testThoughtSearchNoShellInjection },
    { name: "topics parser with wiki links", run: testTopicsParserWithWikiLinks },
    { name: "memory stable proposition IDs", run: testMemoryStablePropositionIds },
    { name: "pipeline revisit phase alias", run: testLocalPipelineRevisitAlias },
    { name: "heartbeat queue taskId compatibility", run: testHeartbeatQueueTaskIdCompatibility },
    { name: "fork timeout hardening", run: testForkTimeoutHardening },
    { name: "source path links ignored for dangling wiki checks", run: testSourcePathLinksIgnoredForDanglingWikiChecks },
    { name: "graph scan excludes code block examples", run: testGraphScanExcludesCodeBlockExamples },
    { name: "write validation kebab-case warning", run: testWriteValidateWarnsOnNonKebabFileName },
    { name: "runtime MCP boundary preserved", run: testRuntimeMcpBoundaryPreserved },
    { name: "stop-capture: strong signal produces capture", run: testDetectCapturableInsightsStrongSignal },
    { name: "stop-capture: generic noise rejected", run: testDetectCapturableInsightsNoiseRejection },
    { name: "stop-capture: short text rejected", run: testDetectCapturableInsightsShortTextRejected },
    { name: "stop-capture: transcript parser filters user messages", run: testExtractRecentAssistantTextFiltersUserMessages },
    { name: "stop-capture: transcript parser skips malformed lines", run: testParseTranscriptLinesSkipsMalformed },
    { name: "stop-capture: dedup flags identical claim", run: testIsDuplicateCaptureDetectsHighOverlap },
    { name: "stop-capture: dedup allows distinct claims", run: testIsDuplicateCaptureAllowsDistinctClaims },
    { name: "stop-capture: dedup handles missing inbox", run: testIsDuplicateCaptureHandlesMissingInbox },
    { name: "stop-capture: normalize strips special chars", run: testNormalizeForComparisonStripsSpecialChars },
    { name: "stop-capture: slugify produces kebab-case", run: testSlugifyProducesKebabCase },
    { name: "stop-capture: Stop hook registered in install.ts", run: testStopCaptureHookRegistered },
  ];

  let passed = 0;
  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`PASS: ${test.name}`);
    } catch (err) {
      console.error(`FAIL: ${test.name}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  console.log(`\nRegression checks passed: ${passed}/${tests.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
