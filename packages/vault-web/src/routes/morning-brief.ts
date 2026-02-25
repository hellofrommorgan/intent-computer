/**
 * Morning brief route — GET /morning-brief
 *
 * Reads and renders ops/morning-brief.md.
 * Owner-only route.
 */

import { Hono } from "hono";
import { readVaultFile } from "../lib/vault-reader.js";
import { renderMarkdown } from "../lib/markdown.js";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

export function createMorningBriefRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get("/", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) return c.text("Unauthorized", 401);

        const brief = readVaultFile(vaultDir, "ops/morning-brief.md");

        if (!brief) {
            const content = `
                <h1 class="text-2xl font-bold mb-6">Morning Brief</h1>
                <div class="bg-gray-900 rounded-lg p-6 border border-gray-800">
                    <p class="text-gray-500">No morning brief yet. The heartbeat will generate one on its next run.</p>
                </div>
            `;

            return c.html(
                layout({ title: "Morning Brief", content, isOwner: true, activeNav: "Brief" }),
            );
        }

        const briefHtml = renderMarkdown(brief.content);

        const content = `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-2xl font-bold">Morning Brief</h1>
                <span class="text-gray-500 text-sm">Last updated: ${brief.modified.toLocaleDateString()} ${brief.modified.toLocaleTimeString()}</span>
            </div>
            <div class="prose prose-invert max-w-none bg-gray-900 rounded-lg p-6 border border-gray-800">
                ${briefHtml}
            </div>
        `;

        return c.html(
            layout({ title: "Morning Brief", content, isOwner: true, activeNav: "Brief" }),
        );
    });

    return app;
}
