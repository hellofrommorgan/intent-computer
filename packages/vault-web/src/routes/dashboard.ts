/**
 * Dashboard route — GET /
 *
 * Shows: morning brief summary, commitment state, inbox count,
 * recent thoughts, and heartbeat status.
 */

import { Hono } from "hono";
import { readVaultFile, countInboxItems, listThoughts } from "../lib/vault-reader.js";
import { renderMarkdown } from "../lib/markdown.js";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

export function createDashboardRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get("/", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) {
            return c.redirect("/capsules");
        }

        const brief = readVaultFile(vaultDir, "ops/morning-brief.md");
        const inboxCount = countInboxItems(vaultDir);
        const recentThoughts = listThoughts(vaultDir).slice(0, 10);
        const goals = readVaultFile(vaultDir, "self/goals.md");

        const briefHtml = brief ? renderMarkdown(brief.content) : "<p>No morning brief yet.</p>";
        const goalsHtml = goals ? renderMarkdown(goals.content) : "";

        const thoughtsList = recentThoughts
            .map((t) => `
                <li class="py-2 border-b border-gray-800">
                    <a href="/thoughts/${t.slug}" class="text-blue-400 hover:text-blue-300">${t.title}</a>
                    <span class="text-gray-500 text-sm ml-2">${t.type ?? ""}</span>
                    ${t.description ? `<p class="text-gray-400 text-sm mt-1">${t.description}</p>` : ""}
                </li>
            `)
            .join("");

        const content = `
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                    <h3 class="text-sm font-semibold text-gray-400 uppercase mb-1">Inbox</h3>
                    <p class="text-3xl font-bold">${inboxCount}</p>
                    ${inboxCount > 0 ? '<a href="/inbox" class="text-sm text-blue-400">View items</a>' : ""}
                </div>
                <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                    <h3 class="text-sm font-semibold text-gray-400 uppercase mb-1">Thoughts</h3>
                    <p class="text-3xl font-bold">${recentThoughts.length}+</p>
                    <a href="/thoughts" class="text-sm text-blue-400">Browse all</a>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                    <h3 class="text-sm font-semibold text-gray-400 uppercase mb-1">Last Brief</h3>
                    <p class="text-sm text-gray-300">${brief ? brief.modified.toLocaleDateString() : "Never"}</p>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                    <h2 class="text-xl font-bold mb-4">Morning Brief</h2>
                    <div class="prose prose-invert max-w-none bg-gray-900 rounded-lg p-6 border border-gray-800">
                        ${briefHtml}
                    </div>
                </div>
                <div>
                    <h2 class="text-xl font-bold mb-4">Goals</h2>
                    <div class="prose prose-invert max-w-none bg-gray-900 rounded-lg p-6 border border-gray-800">
                        ${goalsHtml}
                    </div>
                </div>
            </div>

            <div class="mt-8">
                <h2 class="text-xl font-bold mb-4">Recent Thoughts</h2>
                <ul class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                    ${thoughtsList || '<li class="text-gray-500">No thoughts yet.</li>'}
                </ul>
            </div>
        `;

        return c.html(layout({
            title: "Dashboard",
            content,
            isOwner: true,
            activeNav: "Dashboard",
        }));
    });

    return app;
}
