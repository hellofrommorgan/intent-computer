/**
 * test-fork.ts
 *
 * Validates the fork.ts → pipeline.ts call chain against a real inbox file.
 * Uses a mock client to capture what would be sent to the forked session.
 *
 * Run: npx tsx scripts/test-fork.ts
 *
 * What this tests:
 *   1. loadSkillInstructions() resolves the reduce SKILL.md with vocabulary applied
 *   2. forkSkill() correctly calls client.session.create/prompt/delete
 *   3. The prompt sent to the forked session has the right structure
 *   4. runPipeline() sequences phases correctly
 *   5. Error paths handled gracefully
 *
 * What this does NOT test:
 *   - Whether the real client.session.prompt() supports tool execution
 *   - Whether the forked session can actually write vault files
 *   - That requires a live opencode session: type /pipeline in opencode
 */

import { forkSkill, type ForkOptions } from "../packages/plugin/src/skills/fork.js";
import { loadSkillInstructions } from "../packages/plugin/src/skills/injector.js";
import { runPipeline } from "../packages/plugin/src/skills/pipeline.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";

// ─── Test config ──────────────────────────────────────────────────────────────

const VAULT_ROOT = join(process.env.HOME!, "Mind");
const TEST_FILE = join(VAULT_ROOT, "inbox", "2026-02-19-vector-db-architecture-mechanisms.md");

// ─── Mock client ──────────────────────────────────────────────────────────────

interface CapturedCall {
  method: string;
  args: unknown;
}

const capturedCalls: CapturedCall[] = [];

function makeMockClient(simulateTextOnly = true): PluginInput["client"] {
  return {
    session: {
      create: async (args: unknown) => {
        const typedArgs = args as { body?: { title?: string } };
        capturedCalls.push({ method: "session.create", args });
        console.log(`  → session.create: "${typedArgs?.body?.title ?? "unknown"}"`);
        return { data: { id: `mock-session-${Date.now()}` } } as ReturnType<PluginInput["client"]["session"]["create"]>;
      },

      prompt: async (args: unknown) => {
        const typedArgs = args as {
          path?: { id?: string };
          body?: { system?: string; parts?: Array<{ type: string; text?: string }> };
        };
        capturedCalls.push({ method: "session.prompt", args });

        const systemLen = typedArgs?.body?.system?.length ?? 0;
        const promptLen = typedArgs?.body?.parts?.[0]?.text?.length ?? 0;
        console.log(`  → session.prompt: system=${systemLen} chars, prompt=${promptLen} chars`);

        if (simulateTextOnly) {
          // Simulate: model returns text summary (no tool calls)
          return {
            data: {
              parts: [{
                type: "text",
                text: [
                  `reduce complete on 2026-02-19-vector-db-architecture-mechanisms.md`,
                  ``,
                  `Extracted 4 claims (CLOSED):`,
                  `  1. object storage requires index structures that minimize round trips`,
                  `  2. cache warming decouples cold penalty from interactive query latency`,
                  `  3. strong consistency eliminates stale memory retrieval in agent systems`,
                  `  4. tiered multitenancy trades operational complexity for cost efficiency at scale`,
                  ``,
                  `Files written (handoff mode):`,
                  `  - ${VAULT_ROOT}/ops/queue/vector-db-architecture-mechanisms-001.md`,
                  `  - ${VAULT_ROOT}/ops/queue/vector-db-architecture-mechanisms-002.md`,
                  `  - ${VAULT_ROOT}/ops/queue/vector-db-architecture-mechanisms-003.md`,
                  `  - ${VAULT_ROOT}/ops/queue/vector-db-architecture-mechanisms-004.md`,
                ].join("\n"),
              }],
            },
          } as ReturnType<PluginInput["client"]["session"]["prompt"]>;
        } else {
          return { data: { parts: [] } } as ReturnType<PluginInput["client"]["session"]["prompt"]>;
        }
      },

      delete: async (args: unknown) => {
        const typedArgs = args as { path?: { id?: string } };
        capturedCalls.push({ method: "session.delete", args });
        console.log(`  → session.delete: "${typedArgs?.path?.id ?? "unknown"}"`);
        return { data: {} } as ReturnType<PluginInput["client"]["session"]["delete"]>;
      },
    },
  } as unknown as PluginInput["client"];
}

// Mock $ (bun shell — not needed for client path)
const mockShell = {} as PluginInput["$"];

// ─── Test 1: loadSkillInstructions ────────────────────────────────────────────

async function testSkillLoading(): Promise<boolean> {
  console.log("\n=== TEST 1: loadSkillInstructions ===");

  const skills = ["reduce", "reflect", "reweave", "verify"];
  let allPassed = true;

  for (const skill of skills) {
    const instructions = await loadSkillInstructions(skill, VAULT_ROOT);
    if (!instructions) {
      console.log(`  ✗ ${skill} — SKILL.md not found`);
      allPassed = false;
    } else {
      // Check vocabulary substitution happened
      const hasUnsubstituted = instructions.includes("{vocabulary.");
      const len = instructions.length;
      console.log(`  ${hasUnsubstituted ? "⚠" : "✓"} ${skill} — ${len} chars${hasUnsubstituted ? " (WARN: unsubstituted vocabulary placeholders)" : ""}`);
      if (hasUnsubstituted) allPassed = false;
    }
  }

  return allPassed;
}

// ─── Test 2: forkSkill — single phase ─────────────────────────────────────────

async function testForkSkill(): Promise<boolean> {
  console.log("\n=== TEST 2: forkSkill (reduce phase) ===");

  if (!existsSync(TEST_FILE)) {
    console.log(`  ✗ Test file not found: ${TEST_FILE}`);
    return false;
  }

  const skillInstructions = await loadSkillInstructions("reduce", VAULT_ROOT);
  if (!skillInstructions) {
    console.log("  ✗ Could not load reduce skill instructions");
    return false;
  }

  const taskContext = readFileSync(TEST_FILE, "utf-8");
  const options: ForkOptions = {
    skillName: "reduce",
    skillInstructions,
    taskContext,
    vaultRoot: VAULT_ROOT,
    timeoutMs: 300_000,
  };

  capturedCalls.length = 0; // reset
  const client = makeMockClient(true);

  console.log("  Calling forkSkill...");
  const result = await forkSkill(options, client, mockShell);

  console.log(`\n  Result:`);
  console.log(`    success: ${result.success}`);
  console.log(`    artifacts: ${result.artifacts.length} found`);
  console.log(`    summary (first 200 chars): ${result.summary.slice(0, 200)}`);

  if (result.artifacts.length > 0) {
    for (const a of result.artifacts) {
      console.log(`      - ${a}`);
    }
  }

  const sessionCalls = capturedCalls.filter(c => c.method.startsWith("session."));
  console.log(`\n  Session API calls: ${sessionCalls.map(c => c.method).join(" → ")}`);

  const correct =
    result.success &&
    sessionCalls.some(c => c.method === "session.create") &&
    sessionCalls.some(c => c.method === "session.prompt") &&
    sessionCalls.some(c => c.method === "session.delete");

  console.log(`\n  ${correct ? "✓" : "✗"} forkSkill call chain: create → prompt → delete`);
  return correct;
}

// ─── Test 3: forkSkill — client unavailable (fallback path) ──────────────────

async function testForkFallback(): Promise<boolean> {
  console.log("\n=== TEST 3: forkSkill fallback (no client.session) ===");

  const nullClient = {} as PluginInput["client"]; // no session API
  const instructions = await loadSkillInstructions("reduce", VAULT_ROOT) ?? "(no instructions)";
  const taskContext = existsSync(TEST_FILE) ? readFileSync(TEST_FILE, "utf-8") : "test content";

  const result = await forkSkill(
    { skillName: "reduce", skillInstructions: instructions, taskContext, vaultRoot: VAULT_ROOT },
    nullClient,
    mockShell
  );

  // processFork() will fail because opencode CLI doesn't exist in test env
  // but it should fail GRACEFULLY with success=false, not throw
  console.log(`  success: ${result.success} (expected false — CLI not available)`);
  console.log(`  error: ${result.error ?? "(none)"}`);

  const graceful = !result.success && result.error !== undefined;
  console.log(`  ${graceful ? "✓" : "✗"} fallback fails gracefully`);
  return graceful;
}

// ─── Test 4: prompt structure inspection ──────────────────────────────────────

async function testPromptStructure(): Promise<boolean> {
  console.log("\n=== TEST 4: Prompt structure inspection ===");

  const instructions = await loadSkillInstructions("reduce", VAULT_ROOT) ?? "";
  const taskContext = existsSync(TEST_FILE) ? readFileSync(TEST_FILE, "utf-8") : "test content";

  let capturedPrompt = "";
  let capturedSystem = "";

  const inspectClient: PluginInput["client"] = {
    session: {
      create: async () => ({ data: { id: "inspect-session" } }) as ReturnType<PluginInput["client"]["session"]["create"]>,
      prompt: async (args: unknown) => {
        const typedArgs = args as { body?: { system?: string; parts?: Array<{ text?: string }> } };
        capturedSystem = typedArgs?.body?.system ?? "";
        capturedPrompt = typedArgs?.body?.parts?.[0]?.text ?? "";
        return { data: { parts: [{ type: "text", text: "inspection complete" }] } } as ReturnType<PluginInput["client"]["session"]["prompt"]>;
      },
      delete: async () => ({ data: {} }) as ReturnType<PluginInput["client"]["session"]["delete"]>,
    },
  } as unknown as PluginInput["client"];

  await forkSkill(
    { skillName: "reduce", skillInstructions: instructions, taskContext, vaultRoot: VAULT_ROOT },
    inspectClient,
    mockShell
  );

  console.log(`\n  System prompt (${capturedSystem.length} chars):`);
  console.log("  " + capturedSystem.split("\n").slice(0, 5).join("\n  "));

  console.log(`\n  Prompt structure (${capturedPrompt.length} chars):`);
  const promptLines = capturedPrompt.split("\n");
  const headers = promptLines.filter(l => l.startsWith("## "));
  for (const h of headers) console.log(`    ${h}`);

  const hasSkillInstructions = capturedPrompt.includes("## Skill Instructions: reduce");
  const hasTaskContext = capturedPrompt.includes("## Task Context");
  const hasVaultRoot = capturedSystem.includes(VAULT_ROOT);

  console.log(`\n  ✓/✗ checks:`);
  console.log(`    ${hasSkillInstructions ? "✓" : "✗"} prompt has skill instructions section`);
  console.log(`    ${hasTaskContext ? "✓" : "✗"} prompt has task context section`);
  console.log(`    ${hasVaultRoot ? "✓" : "✗"} system prompt includes vault root`);

  return hasSkillInstructions && hasTaskContext && hasVaultRoot;
}

// ─── Test 5: runPipeline (dry run with mock client) ───────────────────────────

async function testPipelineSequencing(): Promise<boolean> {
  console.log("\n=== TEST 5: runPipeline phase sequencing ===");

  if (!existsSync(TEST_FILE)) {
    console.log(`  ✗ Test file not found`);
    return false;
  }

  const phasesRun: string[] = [];
  const sequencingClient: PluginInput["client"] = {
    session: {
      create: async () => ({ data: { id: "pipe-session" } }) as ReturnType<PluginInput["client"]["session"]["create"]>,
      prompt: async (args: unknown) => {
        const typedArgs = args as { body?: { system?: string } };
        const system = typedArgs?.body?.system ?? "";
        const skillMatch = system.match(/executing the "(\w+)" processing skill/);
        if (skillMatch) phasesRun.push(skillMatch[1]);
        return {
          data: {
            parts: [{ type: "text", text: `${skillMatch?.[1] ?? "unknown"} phase complete` }],
          },
        } as ReturnType<PluginInput["client"]["session"]["prompt"]>;
      },
      delete: async () => ({ data: {} }) as ReturnType<PluginInput["client"]["session"]["delete"]>,
    },
  } as unknown as PluginInput["client"];

  const result = await runPipeline(
    TEST_FILE,
    VAULT_ROOT,
    sequencingClient,
    mockShell,
    { phases: ["reduce", "reflect"] } // just test 2 phases for speed
  );

  console.log(`\n  Phases executed: ${phasesRun.join(" → ")}`);
  console.log(`\n  Pipeline output:\n${result.split("\n").map(l => "    " + l).join("\n")}`);

  const correct =
    phasesRun.includes("reduce") &&
    phasesRun.includes("reflect") &&
    phasesRun.indexOf("reduce") < phasesRun.indexOf("reflect");

  console.log(`\n  ${correct ? "✓" : "✗"} phases ran in correct order: reduce → reflect`);
  return correct;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("intent-computer fork test harness");
  console.log(`vault: ${VAULT_ROOT}`);
  console.log(`test file: ${TEST_FILE}`);

  const results = await Promise.all([
    testSkillLoading().catch(e => { console.error("test 1 error:", e); return false; }),
    Promise.resolve(), // separator
  ]);

  const t1 = results[0] as boolean;

  const t2 = await testForkSkill().catch(e => { console.error("test 2 error:", e); return false; });
  const t3 = await testForkFallback().catch(e => { console.error("test 3 error:", e); return false; });
  const t4 = await testPromptStructure().catch(e => { console.error("test 4 error:", e); return false; });
  const t5 = await testPipelineSequencing().catch(e => { console.error("test 5 error:", e); return false; });

  const passed = [t1, t2, t3, t4, t5].filter(Boolean).length;
  const total = 5;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULTS: ${passed}/${total} tests passed`);
  console.log(`${"=".repeat(50)}`);

  if (passed === total) {
    console.log("\n✓ Fork call chain validated. The TypeScript plumbing is correct.");
    console.log("\nOpen question: does client.session.prompt() allow tool execution?");
    console.log("To find out: type /pipeline inbox/2026-02-19-vector-db-architecture-mechanisms.md");
    console.log("in an opencode session and watch whether the skill writes files to ops/queue/.");
    console.log("\nIf it does: ralph can sequence all phases autonomously.");
    console.log("If not: fork needs to parse structured text output and write files itself.");
  } else {
    console.log("\n✗ Some tests failed — fix before running in opencode.");
  }

  process.exit(passed === total ? 0 : 1);
}

main();
