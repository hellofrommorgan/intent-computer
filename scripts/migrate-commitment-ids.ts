#!/usr/bin/env tsx

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  commitmentPath,
  enforceCommitmentIntegrity,
  writeCommitmentsAtomic,
} from "../packages/architecture/src/commitment-store.js";

interface CommitmentLike {
  id?: string;
  label?: string;
  [key: string]: unknown;
}

interface CommitmentsFile {
  version?: number;
  commitments?: CommitmentLike[];
  lastEvaluatedAt?: string;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): { vaultRoot: string; dryRun: boolean } {
  const args = argv.slice(2);
  let vaultRoot = join(process.env.HOME ?? "/tmp", "Mind");
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vault" && args[i + 1]) {
      vaultRoot = args[i + 1]!;
      i += 1;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { vaultRoot, dryRun };
}

function hasChanged(before: CommitmentLike[], after: CommitmentLike[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i += 1) {
    if ((before[i]?.id ?? "") !== (after[i]?.id ?? "")) return true;
  }
  return false;
}

function main(): void {
  const { vaultRoot, dryRun } = parseArgs(process.argv);
  const filePath = commitmentPath(vaultRoot);

  if (!existsSync(filePath)) {
    console.error(`commitments file not found: ${filePath}`);
    process.exit(1);
  }

  let parsed: CommitmentsFile;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8")) as CommitmentsFile;
  } catch (error) {
    console.error(`failed to parse commitments file: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  const commitments = Array.isArray(parsed.commitments) ? parsed.commitments : [];
  const migrated = enforceCommitmentIntegrity(commitments);
  const changed = hasChanged(commitments, migrated);

  if (!changed) {
    console.log("commitment ID migration: no changes required");
    return;
  }

  const changes = commitments
    .map((commitment, index) => ({
      label: commitment.label ?? `commitment-${index + 1}`,
      from: commitment.id ?? "",
      to: migrated[index]?.id ?? "",
    }))
    .filter((entry) => entry.from !== entry.to);

  console.log(`commitment ID migration: ${changes.length} record(s) will be rekeyed`);
  for (const change of changes.slice(0, 50)) {
    console.log(`- ${change.label}: "${change.from}" -> "${change.to}"`);
  }
  if (changes.length > 50) {
    console.log(`- ... ${changes.length - 50} more`);
  }

  if (dryRun) {
    console.log("dry-run enabled: no files written");
    return;
  }

  writeCommitmentsAtomic(vaultRoot, {
    ...parsed,
    commitments: migrated,
  });
  console.log(`wrote migrated commitments to ${filePath}`);
}

main();
