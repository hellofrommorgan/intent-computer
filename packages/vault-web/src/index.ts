#!/usr/bin/env node
/**
 * @intent-computer/vault-web
 *
 * Minimal web server that makes the vault browsable via HTTPS.
 * Reads markdown files directly from the vault directory — no database, no cache.
 *
 * Usage: node dist/index.js --vault <path> --port <port>
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "path";
import { homedir } from "os";
import { createDashboardRoute } from "./routes/dashboard.js";
import { createThoughtsRoute } from "./routes/thoughts.js";
import { createInboxRoute } from "./routes/inbox.js";
import { createMorningBriefRoute } from "./routes/morning-brief.js";
import { createGraphRoute } from "./routes/graph.js";
import { createCapsulesRoute } from "./routes/capsules.js";
import { authMiddleware, type AppEnv } from "./middleware/auth.js";

// ─── CLI argument parsing ──────────────────────────────────────────────────

function parseArgs(): { vault: string; port: number } {
    const args = process.argv.slice(2);
    let vault = resolve(homedir(), "Mind");
    let port = 8080;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--vault" && args[i + 1]) {
            vault = resolve(args[i + 1]);
            i++;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        }
    }

    return { vault, port };
}

// ─── App setup ─────────────────────────────────────────────────────────────

const { vault, port } = parseArgs();

const app = new Hono<AppEnv>();

// Auth middleware — reads X-ExeDev-UserID header
// If present: full access. If absent: only public capsules.
app.use("*", authMiddleware());

// Routes
app.route("/", createDashboardRoute(vault));
app.route("/thoughts", createThoughtsRoute(vault));
app.route("/inbox", createInboxRoute(vault));
app.route("/morning-brief", createMorningBriefRoute(vault));
app.route("/graph", createGraphRoute(vault));
app.route("/capsules", createCapsulesRoute(vault));

// Static: Tailwind CSS and htmx are loaded from CDN (no build step)

// ─── Start server ──────────────────────────────────────────────────────────

console.log(`vault-web: serving ${vault} on port ${port}`);
serve({ fetch: app.fetch, port });
