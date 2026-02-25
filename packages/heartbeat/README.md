# @intent-computer/heartbeat

Between-session autonomy engine. Wakes on a timer, perceives the world, evaluates commitments against identity, and takes bounded actions without human presence.

Binary: `intent-computer-heartbeat`

## Phase Pipeline

Each run executes a subset of phases in order:

| Phase | Name | What it does |
|-------|------|--------------|
| 4a | Perception | Polls feed sources (X/Twitter via rettiwt-api), scores items against identity relevance (admission-policy.ts), admits high-signal content to inbox |
| 5a | Evaluation | Checks vault conditions (inbox pressure, orphan count, stale sessions), evaluates commitment advancement and drift detection, scores all thoughts by graph impact |
| 5b | Execution | Selects and triggers queue tasks through a runner, filtered and reordered by commitment relevance. Defers thin-desire and constitutive-friction tasks |
| 5c | Threshold Actions | Auto-seeds inbox items into the pipeline queue, fires threshold-triggered actions (observations triage, tension resolution) when conditions exceed limits |
| 6 | Morning Brief | Synthesizes `ops/morning-brief.md` via LLM -- commitment status, drift scores, perception findings, queue state. Skipped during evening/overnight slots |
| 7 | Working Memory | Updates `self/working-memory.md` with actions performed this cycle via LLM synthesis |

## CLI Usage

```
intent-computer-heartbeat [options]

Options:
  --vault <path>           Vault root (default: ~/Mind)
  --phases <list>          Comma-separated phases: 4a,5a,5b,5c,6,7 (default: all)
  --dry-run                Preview without mutating state
  --max-actions <n>        Max queue tasks per run (default: 3)
  --slot <slot>            morning | evening | overnight | manual (default: manual)
  --task-selection <mode>  queue-first | aligned-first (default: queue-first)
  --repair-mode <mode>     queue-only | execute (default: queue-only)
  --threshold-mode <mode>  queue-only | execute (default: queue-only)
  --runner-cmd <command>   Shell command for task execution
  --runner-timeout <ms>    Runner timeout (default: 1800000)
  --config <path>          Path to ops/config.yaml

Schedule management:
  --install-schedule       Install launchd/systemd timer jobs
  --uninstall-schedule     Remove timer jobs
  --schedule-status        Check installation status
```

## Scheduling

### macOS (launchd)

`--install-schedule` creates three calendar-interval plist files in `~/Library/LaunchAgents/`:

- `com.intent-computer.heartbeat.morning` -- 6:00 AM, full pipeline with `--slot morning`
- `com.intent-computer.heartbeat.evening` -- 9:00 PM, full pipeline with `--slot evening`
- `com.intent-computer.heartbeat.overnight` -- hourly 11 PM-6 AM, with `--slot overnight`

### Linux / exe.dev (systemd)

Systemd timer units, same schedule semantics. Detected automatically by platform.

## Runner Modes

### Local (runner.ts)

Invokes `claude` CLI with `--dangerously-skip-permissions -p`. Used on macOS where Claude CLI is installed locally. Default model: `sonnet`. Timeout: 30 min. Tracks `INTENT_HEARTBEAT_DEPTH` env var to prevent recursive spawning.

### Gateway (gateway-runner.ts)

Direct HTTP POST to the Anthropic Messages API via exe.dev's LLM gateway at `169.254.169.252`. No API key required -- the link-local metadata address handles auth. Default model: `claude-sonnet-4-5-20250929`. Timeout: 5 min.

Activated when `EXE_DEV=1` or `INTENT_USE_GATEWAY=true` is set, or when `isGatewayAvailable()` detects the gateway at the link-local address.

## Configuration

- **Vault config**: `<vault>/ops/config.yaml` -- maintenance thresholds, processing depth
- **Commitments**: `<vault>/ops/commitments.json` -- the commitment store (state machine with candidate/active/paused/satisfied/abandoned lifecycle)
- **Queue**: `<vault>/ops/queue.json` -- pipeline task queue consumed by phase 5b
- **Feed cursors**: Cursor store tracks polling positions across feed sources

## Dependencies

- `@intent-computer/architecture` -- shared types, queue/graph utilities, event emitters
- `rettiwt-api` -- X/Twitter feed polling for perception phase
