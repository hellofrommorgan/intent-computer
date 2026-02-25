/**
 * pi-dev/index.ts — pi.dev extension adapter for intent-computer
 *
 * Maps pi.dev extension lifecycle events to the intent-computer runtime.
 * Loaded via jiti — no compilation needed.
 *
 * Event mapping:
 *   - session_start: Load vault context, initialize session state
 *   - before_agent_start: Inject vault context into system prompt
 *   - tool_result (write tools): Write validation + async auto-commit
 *   - session_shutdown: Session capture (git commit) + session continuity
 *   - session_before_compact: Re-inject fresh vault context
 *
 * Registers slash commands for skills via pi.registerCommand().
 *
 * pi.dev types are inlined as the @pi/sdk package is not published.
 * Source: https://docs.pi.dev/extensions
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ─── pi.dev types (inlined — no published SDK) ──────────────────────────────

/** The ExtensionAPI object passed to the default export. */
interface PiExtensionAPI {
  on(event: string, handler: (...args: any[]) => void | Promise<void>): void;
  registerTool(tool: PiTool): void;
  registerCommand(command: PiCommand): void;
}

interface PiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

interface PiCommand {
  name: string;
  description: string;
  execute: (args: string) => Promise<string>;
}

interface PiSessionStartEvent {
  sessionId: string;
  workingDirectory?: string;
}

interface PiBeforeAgentStartEvent {
  sessionId: string;
  systemPrompt: string;
  modifySystemPrompt: (prompt: string) => void;
}

interface PiToolResultEvent {
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  modifyResult: (result: string) => void;
}

interface PiSessionShutdownEvent {
  sessionId: string;
}

interface PiSessionBeforeCompactEvent {
  sessionId: string;
  systemPrompt: string;
  modifySystemPrompt: (prompt: string) => void;
}

// ─── Vault detection (mirrors vaultguard.ts logic) ───────────────────────────

function checkDir(dir: string): string | null {
  if (existsSync(join(dir, ".arscontexta"))) return dir;
  if (existsSync(join(dir, "ops", "config.yaml"))) return dir;
  if (existsSync(join(dir, ".claude", "hooks", "session-orient.sh"))) return dir;
  return null;
}

function detectVault(worktree?: string): string | null {
  if (worktree) {
    const fromWorktree = checkDir(worktree);
    if (fromWorktree) return fromWorktree;
  }

  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, "Mind"),
    join(home, "mind"),
    join(home, "Documents", "Mind"),
    join(home, "notes"),
  ];
  for (const candidate of candidates) {
    const found = checkDir(candidate);
    if (found) return found;
  }

  return null;
}

// ─── Note path detection (mirrors vaultguard.ts) ─────────────────────────────

function isNotePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return ["/thoughts/", "/inbox/", "/notes/", "/thinking/", "/claims/"].some(
    (segment) => normalized.includes(segment),
  );
}

function toAbsoluteVaultPath(vaultRoot: string, filePath: string): string {
  if (filePath.startsWith("/")) return filePath;
  return join(vaultRoot, filePath);
}

// ─── Kebab-case detection (inlined from @intent-computer/architecture) ───────
// Inlined to avoid module resolution issues — jiti may not resolve workspace
// packages when loaded from ~/.pi/agent/extensions/.

function isKebabCase(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s);
}

// ─── Auto-commit (mirrors auto-commit.ts) ────────────────────────────────────
// Uses execSync since pi.dev does not provide a shell subprocess helper ($).

function autoCommitSync(vaultRoot: string, changedFile: string): void {
  if (!isNotePath(changedFile)) return;
  const absoluteChangedFile = toAbsoluteVaultPath(vaultRoot, changedFile);
  if (!absoluteChangedFile.startsWith(vaultRoot)) return;

  try {
    execSync(`git -C "${vaultRoot}" rev-parse --git-dir`, {
      stdio: "ignore",
    });
  } catch {
    return;
  }

  const paths = [
    absoluteChangedFile,
    join(vaultRoot, "self"),
    join(vaultRoot, "ops"),
    join(vaultRoot, "inbox"),
  ];

  for (const p of paths) {
    try {
      execSync(`git -C "${vaultRoot}" add "${p}"`, { stdio: "ignore" });
    } catch {
      // Path may not exist
    }
  }

  let status: string;
  try {
    status = execSync(`git -C "${vaultRoot}" diff --cached --name-only`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return;
  }
  if (!status) return;

  const changedFiles = status.split("\n");
  const count = changedFiles.length;
  const names = changedFiles
    .slice(0, 3)
    .map((f) => f.split("/").pop())
    .join(", ");
  const suffix = count > 3 ? ` +${count - 3} more` : "";
  const message = `auto: update ${count} note(s) — ${names}${suffix}`;

  try {
    execSync(`git -C "${vaultRoot}" commit -m "${message}" --no-verify`, {
      stdio: "ignore",
    });
  } catch {
    // Swallow
  }
}

// ─── Session capture (mirrors session-capture.ts) ────────────────────────────

function sessionCaptureSync(vaultRoot: string): void {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);

  try {
    execSync(`git -C "${vaultRoot}" rev-parse --git-dir`, {
      stdio: "ignore",
    });
  } catch {
    return;
  }

  const paths = [
    join(vaultRoot, "ops", "sessions"),
    join(vaultRoot, "ops", "observations"),
    join(vaultRoot, "ops", "methodology"),
    join(vaultRoot, "self", "goals.md"),
    join(vaultRoot, "self", "working-memory.md"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        execSync(`git -C "${vaultRoot}" add "${p}"`, { stdio: "ignore" });
      } catch {
        // Best-effort
      }
    }
  }

  let status: string;
  try {
    status = execSync(`git -C "${vaultRoot}" diff --cached --name-only`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return;
  }
  if (!status) return;

  try {
    execSync(
      `git -C "${vaultRoot}" commit -m "session: capture ${timestamp}" --no-verify`,
      { stdio: "ignore" },
    );
  } catch {
    // Swallow
  }
}

// ─── Vault context loading ───────────────────────────────────────────────────

function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

interface VaultContext {
  identity: string | null;
  goals: string | null;
  workingMemory: string | null;
  morningBrief: string | null;
}

function loadVaultContext(vaultRoot: string): VaultContext {
  return {
    identity: safeRead(join(vaultRoot, "self", "identity.md")),
    goals: safeRead(join(vaultRoot, "self", "goals.md")),
    workingMemory: safeRead(join(vaultRoot, "self", "working-memory.md")),
    morningBrief: safeRead(join(vaultRoot, "ops", "morning-brief.md")),
  };
}

function buildContextPrompt(ctx: VaultContext, vaultRoot: string): string {
  const sections: string[] = [];

  sections.push(`[intent-computer] Vault: ${vaultRoot}`);

  if (ctx.identity) {
    sections.push(`--- Identity ---\n${ctx.identity}`);
  }

  if (ctx.workingMemory) {
    sections.push(`--- Working Memory ---\n${ctx.workingMemory}`);
  }

  if (ctx.goals) {
    sections.push(`--- Goals ---\n${ctx.goals}`);
  }

  if (ctx.morningBrief) {
    sections.push(`--- Morning Brief ---\n${ctx.morningBrief}`);
  }

  return sections.join("\n\n");
}

// ─── Skill injector (mirrors injector.ts) ────────────────────────────────────

function findSkillSourcesDir(): string | null {
  // When loaded via jiti, __dirname resolves to this file's directory.
  // Walk up to find the plugin package root, then into src/skill-sources.
  // We also check relative to the package root in case dist/ is used.
  const candidates = [
    join(__dirname, "..", "..", "skill-sources"),        // src/adapters/pi-dev -> src/skill-sources
    join(__dirname, "..", "..", "..", "src", "skill-sources"), // dist/adapters/pi-dev -> src/skill-sources
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function findPluginSkillsDir(): string | null {
  const candidates = [
    join(__dirname, "..", "..", "plugin-skills"),
    join(__dirname, "..", "..", "..", "src", "plugin-skills"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function loadSkillContent(skillName: string): string | null {
  const skillSourcesDir = findSkillSourcesDir();
  if (skillSourcesDir) {
    const path = join(skillSourcesDir, skillName, "SKILL.md");
    if (existsSync(path)) {
      return extractBody(readFileSync(path, "utf-8"));
    }
  }

  const pluginSkillsDir = findPluginSkillsDir();
  if (pluginSkillsDir) {
    const path = join(pluginSkillsDir, skillName, "SKILL.md");
    if (existsSync(path)) {
      return extractBody(readFileSync(path, "utf-8"));
    }
  }

  return null;
}

function extractBody(skillMd: string): string {
  if (!skillMd.startsWith("---")) return skillMd;
  const closingDelim = skillMd.indexOf("---", 3);
  if (closingDelim === -1) return skillMd;
  return skillMd.slice(closingDelim + 3).trim();
}

function loadVocabulary(vaultRoot: string): Record<string, string> {
  const manifestPath = join(vaultRoot, "ops", "derivation-manifest.md");
  if (!existsSync(manifestPath)) return {};

  try {
    const content = readFileSync(manifestPath, "utf-8");
    // Minimal vocabulary parser — extract key: value pairs from code blocks
    const codeBlockMatch = content.match(/```[\s\S]*?```/);
    if (!codeBlockMatch) return {};
    const lines = codeBlockMatch[0].split("\n").slice(1, -1);
    const vocab: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) vocab[match[1]] = match[2].trim();
    }
    return vocab;
  } catch {
    return {};
  }
}

function applyVocabulary(
  content: string,
  vocabulary: Record<string, string>,
): string {
  return content.replace(/\{vocabulary\.(\w+)\}/g, (match, key) => {
    return vocabulary[key] ?? match;
  });
}

function injectSkill(
  skillName: string,
  vaultRoot: string,
): string | null {
  const skillContent = loadSkillContent(skillName);
  if (!skillContent) return null;

  const vocabulary = loadVocabulary(vaultRoot);
  const transformed = applyVocabulary(skillContent, vocabulary);

  return [
    `=== ACTIVE SKILL: ${skillName} ===`,
    ``,
    `The user has invoked the /${skillName} skill. Follow these instructions for this response:`,
    ``,
    transformed,
    ``,
    `=== END SKILL: ${skillName} ===`,
  ].join("\n");
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function logEvent(vaultRoot: string, message: string): void {
  try {
    const runtimeDir = join(vaultRoot, "ops", "runtime");
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(
      join(runtimeDir, "pi-dev-extension.log"),
      `${ts} ${message}\n`,
      "utf-8",
    );
  } catch {
    // Logging is best-effort
  }
}

// ─── Write tool names across hosts ──────────────────────────────────────────

const WRITE_TOOL_NAMES = new Set([
  "write",
  "write_file",
  "file_write",
  "create_file",
  "Edit",            // Claude Code
  "Write",           // Claude Code
  "edit_file",
  "str_replace_editor",
]);

// ─── Skill registry for command registration ─────────────────────────────────

const REGISTERABLE_SKILLS: Record<string, string> = {
  setup: "Initialize or configure the knowledge vault",
  health: "Run vault health checks and diagnostics",
  stats: "Show vault metrics and statistics",
  surface: "Extract meaning from raw input (alias: /reduce)",
  reflect: "Find connections between thoughts",
  verify: "Check thought quality against schema",
  validate: "Batch schema validation across all thoughts",
  seed: "Queue material for pipeline processing",
  process: "Run pipeline tasks from the queue",
  tasks: "Show pipeline task queue status",
  graph: "Interactive graph queries and analysis",
  next: "Get intelligent next-action recommendations",
  learn: "Research a topic and grow the graph",
  remember: "Capture friction and methodology learnings",
  rethink: "Review accumulated observations and tensions",
  reweave: "Revisit old thoughts with new context",
  refactor: "Restructure vault organization",
  reduce: "Extract and compress insights from input",
  help: "Show available commands and capabilities",
};

// ─── Extension entry point ───────────────────────────────────────────────────

interface SessionState {
  id: string;
  startedAt: Date;
  vaultContext: VaultContext | null;
  pendingSkill: string | null;
}

export default function intentComputerExtension(pi: PiExtensionAPI): void {
  const sessions = new Map<string, SessionState>();
  let vaultRoot: string | null = null;

  // ─── session_start: detect vault, load context ───────────────────────────

  pi.on("session_start", (event: PiSessionStartEvent) => {
    const workDir = event.workingDirectory ?? process.cwd();
    vaultRoot = detectVault(workDir);

    const state: SessionState = {
      id: event.sessionId,
      startedAt: new Date(),
      vaultContext: null,
      pendingSkill: null,
    };

    if (vaultRoot) {
      state.vaultContext = loadVaultContext(vaultRoot);
      logEvent(vaultRoot, `session_start: ${event.sessionId} vault=${vaultRoot}`);
    }

    sessions.set(event.sessionId, state);
  });

  // ─── before_agent_start: inject vault context into system prompt ─────────

  pi.on("before_agent_start", (event: PiBeforeAgentStartEvent) => {
    if (!vaultRoot) return;

    const state = sessions.get(event.sessionId);
    if (!state?.vaultContext) return;

    const contextPrompt = buildContextPrompt(state.vaultContext, vaultRoot);

    // If a skill was queued via slash command, inject it too
    let skillPrompt = "";
    if (state.pendingSkill) {
      const injected = injectSkill(state.pendingSkill, vaultRoot);
      if (injected) skillPrompt = "\n\n" + injected;
      state.pendingSkill = null;
    }

    event.modifySystemPrompt(
      contextPrompt + skillPrompt + "\n\n" + event.systemPrompt,
    );
  });

  // ─── tool_result: write validation + auto-commit ─────────────────────────

  pi.on("tool_result", (event: PiToolResultEvent) => {
    if (!vaultRoot) return;
    if (!WRITE_TOOL_NAMES.has(event.toolName)) return;

    const args = event.toolArgs;
    const filePath: string =
      (args.filePath as string) ??
      (args.path as string) ??
      (args.file_path as string) ??
      "";
    if (!filePath) return;
    if (!isNotePath(filePath)) return;

    const absolutePath = toAbsoluteVaultPath(vaultRoot, filePath);
    if (!absolutePath.startsWith(vaultRoot)) return;

    // Synchronous write validation — append warnings to result
    const warnings = writeValidateSync(absolutePath);
    if (warnings) {
      event.modifyResult(event.result + "\n\n" + warnings);
    }

    // Fire auto-commit asynchronously (non-blocking)
    const vault = vaultRoot; // capture for closure
    setTimeout(() => {
      try {
        autoCommitSync(vault, absolutePath);
      } catch {
        // Auto-commit is best-effort
      }
    }, 0);
  });

  // ─── session_shutdown: session capture + continuity ──────────────────────

  pi.on("session_shutdown", (event: PiSessionShutdownEvent) => {
    if (!vaultRoot) return;

    const state = sessions.get(event.sessionId);

    logEvent(vaultRoot, `session_shutdown: ${event.sessionId}`);

    // Session capture: commit pending vault changes
    try {
      sessionCaptureSync(vaultRoot);
    } catch {
      // Best-effort
    }

    // Note: session continuity (LLM-based working memory update) is not
    // available in the pi.dev adapter because it requires an LLM client API.
    // pi.dev does not expose a programmatic LLM call interface to extensions.
    // If pi.dev adds this capability, session continuity can be wired in here.

    sessions.delete(event.sessionId);
  });

  // ─── session_before_compact: re-inject fresh context ─────────────────────

  pi.on("session_before_compact", (event: PiSessionBeforeCompactEvent) => {
    if (!vaultRoot) return;

    // Reload context fresh — vault state may have changed during session
    const freshContext = loadVaultContext(vaultRoot);
    const contextPrompt = buildContextPrompt(freshContext, vaultRoot);

    event.modifySystemPrompt(
      contextPrompt + "\n\n" + event.systemPrompt,
    );
  });

  // ─── Register slash commands for skills ──────────────────────────────────

  for (const [skillName, description] of Object.entries(REGISTERABLE_SKILLS)) {
    pi.registerCommand({
      name: skillName,
      description,
      execute: async (args: string) => {
        if (!vaultRoot) {
          return "No vault detected. Run /setup to initialize your knowledge system.";
        }

        // Queue the skill for injection on next agent turn.
        // pi.dev commands return text that gets shown to the agent,
        // but skill injection happens via system prompt modification.
        // We store the pending skill so before_agent_start can inject it.
        const currentSession = [...sessions.values()].at(-1);
        if (currentSession) {
          currentSession.pendingSkill = skillName;
        }

        const skillContent = loadSkillContent(skillName);
        if (!skillContent) {
          return `Skill /${skillName} not found. The skill SKILL.md file may be missing from the plugin package.`;
        }

        // Return a brief instruction for the agent
        return `Skill /${skillName} activated${args ? ` with args: ${args}` : ""}. Instructions injected into system prompt. Follow the skill instructions for this response.`;
      },
    });
  }
}

// ─── Synchronous wrapper for writeValidate ───────────────────────────────────
// pi.dev tool_result handlers may or may not support async. We provide a sync
// path that mirrors the async writeValidate but runs synchronously.

function writeValidateSync(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const warnings: string[] = [];
  const filename = filePath.split("/").pop() ?? "";
  const stem = filename.replace(/\.md$/, "");

  if (stem && isKebabCase(stem)) {
    const suggested = stem.replace(/-/g, " ");
    warnings.push(
      `filename uses kebab-case but vault convention is prose-with-spaces (suggested: ${suggested}.md)`,
    );
  }

  const hasOpeningDelimiter = /^---\s*(?:\n|$)/.test(content);
  const frontmatterMatch = content.match(
    /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/,
  );

  if (!hasOpeningDelimiter) {
    warnings.push("Missing YAML frontmatter opening delimiter (---)");
  } else if (!frontmatterMatch) {
    warnings.push("Missing YAML frontmatter closing delimiter (---)");
  } else {
    const frontmatter = frontmatterMatch[1];

    const descMatch = frontmatter.match(/^description:\s*(.+)\s*$/m);
    if (!descMatch) {
      warnings.push("Missing required field: description");
    } else {
      const rawDesc = descMatch[1].trim();
      const desc = rawDesc.replace(/^['"]|['"]$/g, "").trim();
      const titleFromFilename = filename.replace(/\.md$/, "");
      if (desc.toLowerCase() === titleFromFilename.toLowerCase()) {
        warnings.push(
          "description is identical to the title — add information beyond the title",
        );
      }
      if (desc.length < 20) {
        warnings.push(
          `description is too short (${desc.length} chars) — aim for ~150 chars that add context`,
        );
      }
    }

    const topicsKeyMatch = frontmatter.match(/^topics:\s*(.*)$/m);
    if (!topicsKeyMatch) {
      warnings.push(
        "Missing required field: topics — this thought needs at least one map link",
      );
    } else {
      const inlineTopics = topicsKeyMatch[1].trim();
      const hasInlineTopics =
        inlineTopics.length > 0 && inlineTopics !== "[]";
      const blockTopicsMatch = frontmatter.match(
        /^topics:\s*\n((?:\s*-\s*.+\n?)*)/m,
      );
      const blockTopicCount = blockTopicsMatch
        ? blockTopicsMatch[1]
            .split("\n")
            .filter((line) => /^\s*-\s*.+/.test(line)).length
        : 0;

      if (!hasInlineTopics && blockTopicCount === 0) {
        warnings.push("topics is empty — add at least one map link topic");
      }
    }
  }

  if (warnings.length === 0) return null;

  return `\n\u26a0\ufe0f Schema warnings for ${filename}:\n${warnings.map((w) => `  - ${w}`).join("\n")}`;
}
