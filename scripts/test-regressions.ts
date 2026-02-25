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
import { migrateWave12Contracts } from "./migrate-wave12-contracts.js";

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
      written.thoughtId === "hello-world",
      `thought_write should return slug thoughtId, got "${written.thoughtId}"`,
    );

    const readBack = await adapter.thoughtGet({
      vaultId: "local",
      thoughtId: written.thoughtId,
    });
    assert(readBack !== null, "thought_get should load thought_write output");
    assert(
      readBack?.id === "hello-world",
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
        prompt: async () => new Promise(() => {}),
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
    const path = join(vault, "thoughts", "Mixed Case Title.md");
    writeFileSync(
      path,
      `---\ndescription: \"desc long enough for validation\"\ntopics: [\"[[topic]]\"]\n---\n\nbody\n`,
      "utf-8",
    );

    const warning = await writeValidate(path);
    assert(warning?.includes("kebab-case"), "write validation should warn on non-kebab filenames");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function latestMigrationReportJson(vault: string): string {
  const migrationsRoot = join(vault, "ops", "migrations");
  const runs = readdirSync(migrationsRoot).sort();
  const latest = runs[runs.length - 1];
  return join(migrationsRoot, latest!, "report.json");
}

function testMigrationSourceRewriteUniqueMatch(): void {
  const vault = createTempVault();
  try {
    mkdirSync(join(vault, "ops", "queue", "archive", "2026-02-20-batch"), { recursive: true });
    writeFileSync(
      join(vault, "ops", "queue", "archive", "2026-02-20-batch", "source-article.md"),
      "archive source",
      "utf-8",
    );
    writeThought(vault, "migration-note", {
      body: "Source: [[source-article]]",
    });

    const report = migrateWave12Contracts(vault);
    const updated = readFileSync(join(vault, "thoughts", "migration-note.md"), "utf-8");
    assert(report.success, "migration should succeed with unique source match");
    assert(
      updated.includes("Source: [source-article](ops/queue/archive/2026-02-20-batch/source-article.md)"),
      "migration should rewrite Source footer to markdown path link",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testMigrationSourceRewriteAmbiguousFailsFast(): void {
  const vault = createTempVault();
  try {
    mkdirSync(join(vault, "ops", "queue", "archive", "a"), { recursive: true });
    mkdirSync(join(vault, "ops", "queue", "archive", "b"), { recursive: true });
    writeFileSync(join(vault, "ops", "queue", "archive", "a", "dup-source.md"), "a", "utf-8");
    writeFileSync(join(vault, "ops", "queue", "archive", "b", "dup-source.md"), "b", "utf-8");
    writeThought(vault, "needs-source", { body: "Source: [[dup-source]]" });

    let threw = false;
    try {
      migrateWave12Contracts(vault);
    } catch {
      threw = true;
    }
    assert(threw, "migration should fail-fast when Source footer resolution is ambiguous");

    const reportPath = latestMigrationReportJson(vault);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
      success: boolean;
      steps: { sourceFooters: { unresolved: unknown[] } };
    };
    assert(!report.success, "ambiguous source rewrite should produce failed migration report");
    assert(report.steps.sourceFooters.unresolved.length > 0, "failed report should include unresolved source references");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
}

function testMigrationMapExtractionAndFilenameRewrite(): void {
  const vault = createTempVault();
  try {
    writeFileSync(
      join(vault, "thoughts", "Founder Strategy.md"),
      `---\ndescription: \"map\"\ntopics: [\"[[maps]]\"]\n---\n\n# Founder Strategy\n\n## Core Ideas\n- [[thinking note]]\n\n## Agent Notes\n- 2026-02-20: explored path A -> B\n`,
      "utf-8",
    );
    writeFileSync(
      join(vault, "thoughts", "Thinking Note.md"),
      `---\ndescription: \"claim\"\ntopics: [\"[[maps]]\"]\n---\n\n# Thinking Note\n`,
      "utf-8",
    );
    writeFileSync(
      join(vault, "thoughts", "Linker.md"),
      `---\ndescription: \"links\"\ntopics: [\"[[maps]]\"]\n---\n\nReferences [[Thinking Note]].\n`,
      "utf-8",
    );

    const report = migrateWave12Contracts(vault);
    assert(report.success, "migration should complete for map/log and filename rewrite fixtures");
    assert(existsSync(join(vault, "thoughts", "founder-strategy.md")), "map filename should migrate to kebab-case");
    assert(existsSync(join(vault, "thoughts", "thinking-note.md")), "note filename should migrate to kebab-case");

    const map = readFileSync(join(vault, "thoughts", "founder-strategy.md"), "utf-8");
    assert(!map.includes("Agent Notes"), "Agent Notes section should be removed from map files");
    assert(
      existsSync(join(vault, "ops", "observations", "navigation", "founder-strategy.md")),
      "Agent Notes should be relocated to ops/observations/navigation",
    );

    const linker = readFileSync(join(vault, "thoughts", "linker.md"), "utf-8");
    assert(linker.includes("[[thinking-note]]"), "inbound wiki links should be rewritten after filename migration");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
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
    { name: "wave12 migration source rewrite (unique)", run: testMigrationSourceRewriteUniqueMatch },
    { name: "wave12 migration source rewrite (ambiguous fail-fast)", run: testMigrationSourceRewriteAmbiguousFailsFast },
    { name: "wave12 migration map extraction + filename rewrite", run: testMigrationMapExtractionAndFilenameRewrite },
    { name: "runtime MCP boundary preserved", run: testRuntimeMcpBoundaryPreserved },
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
