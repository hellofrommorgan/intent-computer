import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface MaintenanceThresholds {
  inbox: number;
  orphan: number;
  observation: number;
  tension: number;
  sessions: number;
  staleDays: number;
}

const DEFAULT_THRESHOLDS: MaintenanceThresholds = {
  inbox: 3,
  orphan: 5,
  observation: 10,
  tension: 5,
  sessions: 5,
  staleDays: 30,
};

const SESSION_METADATA_KEYS = new Set([
  "session_id",
  "timestamp",
  "status",
  "note",
  "capturedAt",
  "platform",
  "source",
  "sessionID",
  "eventType",
  "title",
  "changes",
  "sessionCreated",
  "sessionUpdated",
  "mineable",
  "mined",
]);

function stripInlineComment(value: string): string {
  const index = value.indexOf("#");
  if (index === -1) return value.trim();
  return value.slice(0, index).trim();
}

function parseYamlScalars(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const indent = match[1].length;
    const key = match[2];
    const remainder = stripInlineComment(match[3]);

    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    if (!remainder) {
      stack.push({ indent, key });
      continue;
    }

    const value = remainder.replace(/^["']|["']$/g, "");
    const path = [...stack.map((node) => node.key), key].join(".");
    result[path] = value;
  }

  return result;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadMaintenanceThresholds(
  vaultRoot: string,
  configPath?: string,
): MaintenanceThresholds {
  const path = configPath ?? join(vaultRoot, "ops", "config.yaml");
  if (!existsSync(path)) return { ...DEFAULT_THRESHOLDS };

  try {
    const content = readFileSync(path, "utf-8");
    const scalars = parseYamlScalars(content);

    return {
      inbox: readNumber(
        scalars["maintenance.conditions.inbox_threshold"],
        DEFAULT_THRESHOLDS.inbox,
      ),
      orphan: readNumber(
        scalars["maintenance.conditions.orphan_threshold"],
        DEFAULT_THRESHOLDS.orphan,
      ),
      observation: readNumber(
        scalars["maintenance.conditions.observation_threshold"],
        DEFAULT_THRESHOLDS.observation,
      ),
      tension: readNumber(
        scalars["maintenance.conditions.tension_threshold"],
        DEFAULT_THRESHOLDS.tension,
      ),
      sessions: readNumber(
        scalars["maintenance.conditions.unprocessed_sessions"],
        DEFAULT_THRESHOLDS.sessions,
      ),
      staleDays: readNumber(
        scalars["maintenance.conditions.stale_days"],
        DEFAULT_THRESHOLDS.staleDays,
      ),
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function hasStructuredSessionContent(payload: Record<string, unknown>): boolean {
  const transcript = payload.transcript;
  if (typeof transcript === "string" && transcript.trim().length > 0) return true;

  const content = payload.content;
  if (typeof content === "string" && content.trim().length > 0) return true;

  const messages = payload.messages;
  if (Array.isArray(messages) && messages.length > 0) return true;

  const events = payload.events;
  if (Array.isArray(events) && events.length > 0) return true;

  return false;
}

export function isMineableSessionRecord(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;

  if (typeof record.mineable === "boolean") return record.mineable;
  if (record.mined === true) return false;
  if (hasStructuredSessionContent(record)) return true;

  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (status.includes("no-content") || status.includes("metadata") || status.includes("stub")) {
    return false;
  }

  const keys = Object.keys(record);
  if (keys.length > 0 && keys.every((key) => SESSION_METADATA_KEYS.has(key))) {
    return false;
  }

  return keys.length > 0;
}

export function countUnprocessedMineableSessions(dir: string): number {
  if (!existsSync(dir)) return 0;

  try {
    let count = 0;
    const files = readdirSync(dir).filter((name) => !name.startsWith("."));

    for (const name of files) {
      if (name.endsWith(".md")) {
        if (!name.toLowerCase().includes("processed")) count++;
        continue;
      }
      if (!name.endsWith(".json")) continue;

      try {
        const payload = JSON.parse(readFileSync(join(dir, name), "utf-8"));
        if (payload?.mined === true) continue;
        if (isMineableSessionRecord(payload)) count++;
      } catch {
        // If JSON is unreadable, assume it is actionable.
        count++;
      }
    }

    return count;
  } catch {
    return 0;
  }
}

export function defaultMaintenanceThresholds(): MaintenanceThresholds {
  return { ...DEFAULT_THRESHOLDS };
}

// ─── Desired State Configuration ─────────────────────────────────────────────

export interface DesiredState {
  /** Max orphan rate as fraction (0-1), default 0.15 */
  maxOrphanRate: number;
  /** Min average connections per thought, default 3.0 */
  minConnectionDensity: number;
  /** Min schema compliance as fraction (0-1), default 0.9 */
  minSchemaCompliance: number;
  /** Min description quality (non-restatement) as fraction (0-1), default 0.85 */
  minDescriptionQuality: number;
  /** Max days an inbox item should sit unprocessed, default 7 */
  inboxMaxAgeDays: number;
  /** Target status distribution */
  statusDistribution: {
    /** Target seed percentage (0-1), default 0.3 */
    seed: number;
    /** Target growing percentage (0-1), default 0.5 */
    growing: number;
    /** Target evergreen percentage (0-1), default 0.2 */
    evergreen: number;
  };
}

export const DEFAULT_DESIRED_STATE: DesiredState = {
  maxOrphanRate: 0.15,
  minConnectionDensity: 3.0,
  minSchemaCompliance: 0.9,
  minDescriptionQuality: 0.85,
  inboxMaxAgeDays: 7,
  statusDistribution: { seed: 0.3, growing: 0.5, evergreen: 0.2 },
};

export function loadDesiredState(
  vaultRoot: string,
  configPath?: string,
): DesiredState {
  const path = configPath ?? join(vaultRoot, "ops", "config.yaml");
  if (!existsSync(path)) return { ...DEFAULT_DESIRED_STATE };

  try {
    const content = readFileSync(path, "utf-8");
    const scalars = parseYamlScalars(content);

    return {
      maxOrphanRate: readNumber(
        scalars["desired_state.max_orphan_rate"],
        DEFAULT_DESIRED_STATE.maxOrphanRate,
      ),
      minConnectionDensity: readNumber(
        scalars["desired_state.min_connection_density"],
        DEFAULT_DESIRED_STATE.minConnectionDensity,
      ),
      minSchemaCompliance: readNumber(
        scalars["desired_state.min_schema_compliance"],
        DEFAULT_DESIRED_STATE.minSchemaCompliance,
      ),
      minDescriptionQuality: readNumber(
        scalars["desired_state.min_description_quality"],
        DEFAULT_DESIRED_STATE.minDescriptionQuality,
      ),
      inboxMaxAgeDays: readNumber(
        scalars["desired_state.inbox_max_age_days"],
        DEFAULT_DESIRED_STATE.inboxMaxAgeDays,
      ),
      statusDistribution: {
        seed: readNumber(
          scalars["desired_state.status_distribution.seed"],
          DEFAULT_DESIRED_STATE.statusDistribution.seed,
        ),
        growing: readNumber(
          scalars["desired_state.status_distribution.growing"],
          DEFAULT_DESIRED_STATE.statusDistribution.growing,
        ),
        evergreen: readNumber(
          scalars["desired_state.status_distribution.evergreen"],
          DEFAULT_DESIRED_STATE.statusDistribution.evergreen,
        ),
      },
    };
  } catch {
    return { ...DEFAULT_DESIRED_STATE };
  }
}
