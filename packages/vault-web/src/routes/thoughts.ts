/**
 * Thoughts routes — GET /thoughts, GET /thoughts/:slug
 */

import { Hono } from "hono";
import { listThoughts, readThought } from "../lib/vault-reader.js";
import { renderMarkdown } from "../lib/markdown.js";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

export function createThoughtsRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // List all thoughts
    app.get("/", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) return c.redirect("/capsules");

        const thoughts = listThoughts(vaultDir);
        const query = c.req.query("q") ?? "";

        const filtered = query
            ? thoughts.filter(
                  (t) =>
                      t.title.toLowerCase().includes(query.toLowerCase()) ||
                      t.description.toLowerCase().includes(query.toLowerCase()) ||
                      t.body.toLowerCase().includes(query.toLowerCase()),
              )
            : thoughts;

        const list = filtered
            .map(
                (t) => `
            <li class="py-3 border-b border-gray-800">
                <a href="/thoughts/${t.slug}" class="text-blue-400 hover:text-blue-300 font-medium">${t.title}</a>
                ${t.type ? `<span class="ml-2 text-xs px-2 py-0.5 bg-gray-800 rounded text-gray-400">${t.type}</span>` : ""}
                ${t.description ? `<p class="text-gray-400 text-sm mt-1">${t.description}</p>` : ""}
                <div class="text-gray-600 text-xs mt-1">
                    ${t.topics.length > 0 ? t.topics.join(" &middot; ") : "no topics"}
                    &middot; ${t.modified.toLocaleDateString()}
                </div>
            </li>
        `,
            )
            .join("");

        const content = `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-2xl font-bold">Thoughts</h1>
                <span class="text-gray-500">${filtered.length} thoughts</span>
            </div>
            <form method="get" class="mb-6">
                <input type="text" name="q" value="${query}" placeholder="Search thoughts..."
                    class="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-gray-100
                           placeholder-gray-500 focus:outline-none focus:border-blue-500">
            </form>
            <ul>${list || '<li class="text-gray-500 py-4">No thoughts found.</li>'}</ul>
        `;

        return c.html(
            layout({ title: "Thoughts", content, isOwner: true, activeNav: "Thoughts" }),
        );
    });

    // Single thought
    app.get("/:slug", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) return c.redirect("/capsules");

        const slug = c.req.param("slug");
        const thought = readThought(vaultDir, slug);

        if (!thought) {
            return c.html(
                layout({
                    title: "Not Found",
                    content: '<p class="text-gray-500">Thought not found.</p>',
                    isOwner: true,
                }),
                404,
            );
        }

        const bodyHtml = renderMarkdown(thought.body);

        const content = `
            <div class="mb-4">
                <a href="/thoughts" class="text-gray-500 hover:text-gray-300 text-sm">&larr; All thoughts</a>
            </div>
            <article class="bg-gray-900 rounded-lg p-6 border border-gray-800">
                <h1 class="text-2xl font-bold mb-2">${thought.title}</h1>
                ${thought.description ? `<p class="text-gray-400 mb-4 italic">${thought.description}</p>` : ""}
                <div class="flex gap-2 mb-6 text-xs">
                    ${thought.type ? `<span class="px-2 py-0.5 bg-gray-800 rounded text-gray-400">${thought.type}</span>` : ""}
                    ${thought.created ? `<span class="text-gray-600">${thought.created}</span>` : ""}
                </div>
                <div class="prose prose-invert max-w-none">
                    ${bodyHtml}
                </div>
                ${
                    thought.topics.length > 0
                        ? `<div class="mt-6 pt-4 border-t border-gray-800">
                        <h3 class="text-sm font-semibold text-gray-500 mb-2">Topics</h3>
                        <div class="flex gap-2 flex-wrap">
                            ${thought.topics.map((t) => `<span class="text-xs px-2 py-1 bg-gray-800 rounded text-purple-400">${t}</span>`).join("")}
                        </div>
                    </div>`
                        : ""
                }
            </article>
        `;

        return c.html(
            layout({ title: thought.title, content, isOwner: true, activeNav: "Thoughts" }),
        );
    });

    return app;
}
