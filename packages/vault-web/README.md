# vault-web

Read-only web UI for browsing an intent computer vault. Not a CMS, not an editor, not an app. A window into markdown files on disk.

## How it works

vault-web is a Hono HTTP server that reads `.md` files directly from a vault directory, parses YAML frontmatter with gray-matter, renders markdown with marked, and serves HTML. No database. No cache. The filesystem is the single source of truth — every request reads from disk.

Wiki links `[[like this]]` are resolved to hyperlinks at render time.

## Routes

| Route | Auth | Description |
|---|---|---|
| `GET /` | Owner | Dashboard: morning brief, inbox count, recent thoughts, goals |
| `GET /thoughts` | Owner | Thought index with search (`?q=`) |
| `GET /thoughts/:slug` | Owner | Single thought, rendered with wiki links |
| `GET /inbox` | Owner | Inbox viewer |
| `GET /morning-brief` | Owner | Rendered morning brief |
| `GET /graph` | Owner | D3 force-directed graph of thought connections |
| `GET /capsules` | Public | Capsule listing (accessible without auth) |
| `GET /capsules/:slug` | Public | Individual capsule |

## Auth model

vault-web does not handle authentication itself. It reads two headers injected by exe.dev's HTTPS proxy:

- `X-ExeDev-UserID` — present if the request is authenticated
- `X-ExeDev-Email` — the authenticated user's email

If `X-ExeDev-UserID` is present, the visitor is treated as the vault owner and gets full access. If absent, only `/capsules` routes are accessible. There are no passwords, sessions, or tokens in vault-web — exe.dev handles all of that upstream.

## Running

```bash
# Default: serves ~/Mind on port 8080
vault-web

# Custom vault path and port
vault-web --vault /path/to/vault --port 3000

# Development (with hot reload)
pnpm dev
```

### On exe.dev

Deploy as a process behind exe.dev's HTTPS proxy. The proxy terminates TLS and injects auth headers. vault-web listens on a local port and trusts whatever headers it receives.

### Locally

Run `vault-web --vault ~/Mind` and open `http://localhost:8080`. Without the proxy headers, every request is treated as a visitor (capsules only). To simulate owner access locally, send requests with the header:

```bash
curl -H "X-ExeDev-UserID: local" http://localhost:8080/
```

## Stack

- **Server**: Hono v4 + @hono/node-server
- **Rendering**: Server-side HTML, Tailwind CSS (CDN), htmx for interactivity
- **Markdown**: marked (rendering) + gray-matter (frontmatter parsing)
- **Graph**: D3 force-directed layout (only JS beyond htmx)
- **Theme**: Dark, minimal

## Building

```bash
pnpm build     # TypeScript → dist/
pnpm typecheck # Type check without emitting
```
