# Intent Computer on exe.dev

Deploy the intent computer as an always-on service on an exe.dev VM. The VM runs a web UI, an autonomous heartbeat, and exposes an MCP server to Claude CLI.

## Files

| File | Purpose |
|------|---------|
| `intent-setup.sh` | One-time setup: installs Node.js 20 (NodeSource), pnpm, clones repo, builds, inits vault, configures MCP, installs systemd units, sets up backup cron |
| `intent-heartbeat.service` | Systemd oneshot -- runs heartbeat with `--slot auto --max-actions 3`, 30-min timeout |
| `intent-heartbeat.timer` | Fires every 15 min (`OnBootSec=2min`, `OnUnitActiveSec=15min`, `Persistent=true`, jitter up to 60s) |
| `vault-web.service` | Long-running web server on port 8080, `Restart=on-failure` |
| `claude-mcp-config.json` | Reference MCP config for Claude CLI (`~/.claude.json`) |

## Deploy

```bash
ssh <vm-name>.exe.dev
curl -sL https://raw.githubusercontent.com/<org>/intent-computer/main/deploy/exe-dev/intent-setup.sh | bash
```

Or clone first and run locally:

```bash
git clone <repo-url> ~/intent-computer
bash ~/intent-computer/deploy/exe-dev/intent-setup.sh
```

The script is idempotent -- re-running it pulls latest, rebuilds, and re-installs services.

## Architecture

```
internet --> exe.dev HTTPS proxy (TLS termination, auth headers)
                |
                v
         vault-web :8080          long-running, serves web UI
         intent-heartbeat         oneshot, every 15 min via systemd timer
         MCP server               stdio, spawned by Claude CLI on demand
         backup cron              git commit + push every 6 hours
```

- **vault-web** serves the vault UI on port 8080. The exe.dev proxy forwards HTTPS traffic here.
- **heartbeat** runs autonomously every 15 minutes (with up to 60s random jitter). Each run picks a slot, executes up to 3 actions, and exits. The timer re-fires regardless of success or failure.
- **MCP server** is stdio-based -- Claude CLI spawns it as a child process per the config in `~/.claude.json`. It is NOT a systemd service and does NOT listen on a port.
- **Node.js 20** is installed via NodeSource (not nvm) because systemd needs a stable `ExecStart` path. nvm's shell-sourcing model breaks systemd units.

## Auth

exe.dev's HTTPS proxy injects `X-ExeDev-UserID` and `X-ExeDev-Email` headers on every request. The proxy terminates TLS and forwards to port 8080. No separate auth layer needed -- if the request reaches vault-web, the user is authenticated.

## Backups

A cron job runs every 6 hours:

```
cd ~/Mind && git add -A && git commit -m 'auto-backup ...' && git push origin main
```

Requires a git remote on the vault. Set one up after initial deploy:

```bash
cd ~/Mind && git remote add origin <your-backup-repo-url>
```

## Operations

```bash
# Service status
systemctl status vault-web
systemctl status intent-heartbeat.timer
systemctl list-timers intent-heartbeat.timer

# Logs
journalctl -u vault-web -f
journalctl -u intent-heartbeat -f

# Manual heartbeat run
sudo systemctl start intent-heartbeat.service

# Rebuild after code changes
cd ~/intent-computer && git pull && pnpm install --frozen-lockfile && pnpm build
sudo systemctl restart vault-web
```
