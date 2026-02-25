import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface VaultPaths {
  identity: string[];
  goals: string[];
  workingMemory: string[];
  morningBrief: string[];
  commitments: string[];
  queue: string[];
  inbox: string;
  thoughts: string;
  observations: string;
  tensions: string;
  sessions: string;
}

export function vaultPaths(vaultRoot: string): VaultPaths {
  return {
    identity: [
      join(vaultRoot, "self", "identity.md"),
      join(vaultRoot, "ops", "identity.md"),
      join(vaultRoot, "identity.md"),
    ],
    goals: [
      join(vaultRoot, "self", "goals.md"),
      join(vaultRoot, "ops", "goals.md"),
    ],
    workingMemory: [
      join(vaultRoot, "self", "working-memory.md"),
      join(vaultRoot, "ops", "working-memory.md"),
    ],
    morningBrief: [join(vaultRoot, "ops", "morning-brief.md")],
    commitments: [join(vaultRoot, "ops", "commitments.json")],
    queue: [join(vaultRoot, "ops", "queue", "queue.json")],
    inbox: join(vaultRoot, "inbox"),
    thoughts: join(vaultRoot, "thoughts"),
    observations: join(vaultRoot, "ops", "observations"),
    tensions: join(vaultRoot, "ops", "tensions"),
    sessions: join(vaultRoot, "ops", "sessions"),
  };
}

export function readFirstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8").trim();
    }
  }
  return null;
}

export function findFirstExistingPath(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
