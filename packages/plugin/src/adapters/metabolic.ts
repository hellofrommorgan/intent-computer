/**
 * metabolic.ts — Vault metabolic rate tracking
 *
 * Queries git history to calculate write rates per vault space (self/, thoughts/,
 * ops/) and detects anomalies like identity churn, pipeline stalls, or system
 * disuse.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type {
  VaultSpace,
  MetabolicAnomaly,
  SpaceMetabolism,
  MetabolicReport,
} from "@intent-computer/architecture";

const execFileAsync = promisify(execFile);

const SPACES: VaultSpace[] = ["self", "thoughts", "ops"];

/**
 * Count unique changed files under a given path prefix within a git repo.
 */
async function countChanges(
  vaultRoot: string,
  space: string,
  since: string,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `--since=${since}`, "--name-only", "--pretty=format:", "--", `${space}/`],
      { cwd: vaultRoot, maxBuffer: 1024 * 1024 },
    );
    const files = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    return files.size;
  } catch {
    return 0;
  }
}

/**
 * Check whether the vault root is inside a git repository.
 */
async function isGitRepo(vaultRoot: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: vaultRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate health for a single vault space based on its write rates.
 */
function evaluateSpace(
  space: VaultSpace,
  changesWeek: number,
  changesMonth: number,
): SpaceMetabolism {
  let healthy = true;
  let anomaly: MetabolicAnomaly | undefined;

  switch (space) {
    case "self":
      if (changesMonth > 5) {
        healthy = false;
        anomaly = "identity-churn";
      }
      break;
    case "thoughts":
      if (changesMonth < 5) {
        healthy = false;
        anomaly = "pipeline-stall";
      }
      break;
    case "ops":
      if (changesWeek === 0) {
        healthy = false;
        anomaly = "ops-silence";
      }
      break;
  }

  return { space, changesWeek, changesMonth, healthy, anomaly };
}

/**
 * Measure metabolic rate across all vault spaces by querying git history.
 *
 * If the vault is not a git repo, returns a zeroed-out report with
 * systemHealthy: true (graceful degradation).
 */
export async function measureMetabolicRate(
  vaultRoot: string,
): Promise<MetabolicReport> {
  const timestamp = new Date().toISOString();

  if (!(await isGitRepo(vaultRoot))) {
    const spaces: SpaceMetabolism[] = SPACES.map((space) => ({
      space,
      changesWeek: 0,
      changesMonth: 0,
      healthy: true,
    }));
    return { timestamp, spaces, anomalies: [], systemHealthy: true };
  }

  const spaces: SpaceMetabolism[] = [];

  for (const space of SPACES) {
    const changesWeek = await countChanges(vaultRoot, space, "7 days ago");
    const changesMonth = await countChanges(vaultRoot, space, "30 days ago");
    spaces.push(evaluateSpace(space, changesWeek, changesMonth));
  }

  // Check for system-wide disuse: all spaces have zero weekly changes
  const allZeroWeek = spaces.every((s) => s.changesWeek === 0);
  if (allZeroWeek) {
    for (const s of spaces) {
      s.healthy = false;
      s.anomaly = "system-disuse";
    }
  }

  const anomalies: MetabolicAnomaly[] = spaces
    .filter((s) => s.anomaly != null)
    .map((s) => s.anomaly!);

  // Deduplicate anomalies
  const uniqueAnomalies = [...new Set(anomalies)];

  const systemHealthy = spaces.every((s) => s.healthy);

  return { timestamp, spaces, anomalies: uniqueAnomalies, systemHealthy };
}
