/**
 * Inbox route — GET /inbox
 *
 * Lists all .md files in inbox/ directory sorted by modified date.
 * Each item shows filename and preview of first 200 chars.
 * Owner-only route.
 */

import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

interface InboxItem {
    filename: string;
    preview: string;
    modified: Date;
}

function listInboxItems(vaultDir: string): InboxItem[] {
    const inboxDir = join(vaultDir, "inbox");
    if (!existsSync(inboxDir)) return [];

    return readdirSync(inboxDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
            const filePath = join(inboxDir, f);
            const content = readFileSync(filePath, "utf-8");
            const stat = statSync(filePath);

            // Strip frontmatter for preview
            let previewText = content;
            if (previewText.startsWith("---")) {
                const endIndex = previewText.indexOf("---", 3);
                if (endIndex !== -1) {
                    previewText = previewText.slice(endIndex + 3).trim();
                }
            }

            return {
                filename: f,
                preview: previewText.slice(0, 200) + (previewText.length > 200 ? "..." : ""),
                modified: stat.mtime,
            };
        })
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function createInboxRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get("/", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) return c.text("Unauthorized", 401);

        const items = listInboxItems(vaultDir);

        const list = items
            .map(
                (item) => `
            <li class="py-3 border-b border-gray-800">
                <div class="flex items-center justify-between">
                    <span class="text-blue-400 font-medium">${item.filename}</span>
                    <span class="text-gray-600 text-xs">${item.modified.toLocaleDateString()}</span>
                </div>
                <p class="text-gray-400 text-sm mt-1">${item.preview}</p>
            </li>
        `,
            )
            .join("");

        const content = `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-2xl font-bold">Inbox</h1>
                <span class="text-gray-500">${items.length} items</span>
            </div>
            <ul class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                ${list || '<li class="text-gray-500 py-4">Inbox is empty. Nothing to process.</li>'}
            </ul>
        `;

        return c.html(
            layout({ title: "Inbox", content, isOwner: true, activeNav: "Inbox" }),
        );
    });

    return app;
}
