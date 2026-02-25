#!/usr/bin/env bash
#
# codex-orchestrate.sh — Sequential execution of Phases A-F via Codex
#
# Each phase:
#   1. Runs codex with the phase prompt
#   2. Verifies the build passes
#   3. Commits the changes
#   4. Moves to the next phase
#
# Usage: ./scripts/codex-orchestrate.sh [start-phase]
#   start-phase: a, b, c, d, e, or f (default: a)
#
# Logs are written to scripts/codex-logs/phase-{X}.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_DIR="$REPO_ROOT/scripts/codex-prompts"
LOG_DIR="$REPO_ROOT/scripts/codex-logs"
SUMMARY_LOG="$LOG_DIR/orchestration-summary.log"

mkdir -p "$LOG_DIR"

# Start phase (default: a)
START_PHASE="${1:-a}"

# All phases in order
ALL_PHASES="a b c d e f"

# bash 3 compatible uppercase
upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

# Phase descriptions for commit messages
phase_desc() {
  case "$1" in
    a) echo "foundation: extract QueueStore, VaultConventions, parseFrontmatter, cap signals, delete legacy" ;;
    b) echo "close loop 1: wire dispatch handlers (orphans, observations, tensions, sessions)" ;;
    c) echo "close loop 2: heartbeat runner, phases 5c/6/7, depth tracking" ;;
    d) echo "deep perception: schema/link/description health checks, /next commitment context" ;;
    e) echo "graph quality: build /reanalyze skill with stale/weak/cascade modes" ;;
    f) echo "hygiene: fix saas-contracts, expand gitignore, portable sync-skills, clean data-feed" ;;
    *) echo "unknown phase" ;;
  esac
}

# ─── Helper functions ─────────────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$SUMMARY_LOG"
}

run_phase() {
  local phase="$1"
  local PHASE_UPPER
  PHASE_UPPER="$(upper "$phase")"
  local prompt_file="$PROMPT_DIR/phase-${phase}.txt"
  local log_file="$LOG_DIR/phase-${phase}.log"
  local desc
  desc="$(phase_desc "$phase")"

  if [ ! -f "$prompt_file" ]; then
    log "ERROR: Prompt file not found: $prompt_file"
    return 1
  fi

  log "=== PHASE ${PHASE_UPPER}: $desc ==="

  # ─── Run Codex ────────────────────────────────────────────────────────────
  log "Running Codex for Phase ${PHASE_UPPER}..."
  local start_time
  start_time=$(date +%s)

  if ! cat "$prompt_file" | codex exec - \
    -m gpt-5.3-codex \
    --full-auto \
    -C "$REPO_ROOT" \
    -c model_reasoning_effort='"xhigh"' \
    2>&1 | tee -a "$log_file"; then
    log "WARNING: Codex exited with non-zero status for Phase ${PHASE_UPPER}"
  fi

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))
  log "Codex Phase ${PHASE_UPPER} completed in ${duration}s"

  # ─── Verify Build ─────────────────────────────────────────────────────────
  log "Verifying build after Phase ${PHASE_UPPER}..."
  if ! pnpm run build 2>&1 | tee -a "$log_file"; then
    log "!!! BUILD FAILED AFTER PHASE ${PHASE_UPPER} !!!"
    log "Check $log_file for details"
    echo "BUILD_FAILED" > "$LOG_DIR/phase-${phase}-status.txt"
    return 1
  fi

  log "Build OK after Phase ${PHASE_UPPER}"
  echo "BUILD_OK" > "$LOG_DIR/phase-${phase}-status.txt"

  # ─── Commit Changes ──────────────────────────────────────────────────────
  log "Committing Phase ${PHASE_UPPER} changes..."
  git -C "$REPO_ROOT" add -A

  if git -C "$REPO_ROOT" diff --cached --quiet; then
    log "No changes to commit for Phase ${PHASE_UPPER}"
  else
    git -C "$REPO_ROOT" commit -m "feat(phase-${phase}): ${desc}

Codex-orchestrated implementation.
Model: gpt-5.3-codex (reasoning: xhigh)
Duration: ${duration}s

Co-Authored-By: Codex <noreply@openai.com>
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
    log "Committed Phase ${PHASE_UPPER}"
  fi

  log "Phase ${PHASE_UPPER} COMPLETE"
  echo ""
  return 0
}

# ─── Determine which phases to run ────────────────────────────────────────────

SKIP=true
PHASES_TO_RUN=""
for phase in $ALL_PHASES; do
  if [ "$phase" = "$START_PHASE" ]; then
    SKIP=false
  fi
  if [ "$SKIP" = false ]; then
    PHASES_TO_RUN="$PHASES_TO_RUN $phase"
  fi
done

PHASES_TO_RUN="$(echo "$PHASES_TO_RUN" | xargs)"

if [ -z "$PHASES_TO_RUN" ]; then
  log "ERROR: Invalid start phase '$START_PHASE'. Use a, b, c, d, e, or f."
  exit 1
fi

# ─── Pre-flight checks ───────────────────────────────────────────────────────

log "=========================================="
log "  CODEX ORCHESTRATION — Phases A-F"
log "=========================================="
log ""
log "Repo: $REPO_ROOT"
log "Start phase: $(upper "$START_PHASE")"
log "Phases to run: $(echo "$PHASES_TO_RUN" | tr '[:lower:]' '[:upper:]')"
log ""

# Check codex is available
if ! command -v codex > /dev/null 2>&1; then
  log "ERROR: 'codex' CLI not found in PATH"
  exit 1
fi

# Check pnpm is available
if ! command -v pnpm > /dev/null 2>&1; then
  log "ERROR: 'pnpm' not found in PATH"
  exit 1
fi

# Check git is clean enough to proceed
if ! git -C "$REPO_ROOT" diff --cached --quiet; then
  log "WARNING: Staged changes detected. Committing as pre-orchestration snapshot..."
  git -C "$REPO_ROOT" commit -m "chore: pre-orchestration snapshot"
fi

# ─── Run phases ──────────────────────────────────────────────────────────────

FAILED_PHASES=""

for phase in $PHASES_TO_RUN; do
  if ! run_phase "$phase"; then
    FAILED_PHASES="$FAILED_PHASES $phase"
    log ""
    log "Phase $(upper "$phase") FAILED. Continuing with remaining phases..."
    log ""
  fi
done

FAILED_PHASES="$(echo "$FAILED_PHASES" | xargs)"

# ─── Final summary ──────────────────────────────────────────────────────────

log ""
log "=========================================="
log "  ORCHESTRATION COMPLETE"
log "=========================================="
log ""
log "Phases run: $(echo "$PHASES_TO_RUN" | tr '[:lower:]' '[:upper:]')"

if [ -z "$FAILED_PHASES" ]; then
  log "Status: ALL PHASES SUCCEEDED"
else
  log "Status: FAILED PHASES: $(echo "$FAILED_PHASES" | tr '[:lower:]' '[:upper:]')"
  log ""
  log "To re-run failed phases:"
  for fp in $FAILED_PHASES; do
    log "  ./scripts/codex-orchestrate.sh $fp"
  done
fi

log ""
log "Logs: $LOG_DIR/"
log "Summary: $SUMMARY_LOG"

# Final build verification
log ""
log "Final build verification..."
if pnpm run build 2>&1 | tee -a "$SUMMARY_LOG"; then
  log "FINAL BUILD: OK"
else
  log "FINAL BUILD: FAILED — repair pass needed"
fi

# Exit with failure if any phase failed
if [ -n "$FAILED_PHASES" ]; then
  exit 1
fi
