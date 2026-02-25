/**
 * Capsule routes — GET /capsules, GET /capsules/:slug
 *
 * Capsules are the ONLY publicly accessible route.
 * Owner sees all capsules. Non-owner sees only public capsules.
 */

import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import { renderMarkdown } from "../lib/markdown.js";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

interface Capsule {
    slug: string;
    title: string;
    description: string;
    isPublic: boolean;
    body: string;
    created: string | null;
    modified: Date;
}

function readCapsule(vaultDir: string, filename: string): Capsule | null {
    const filePath = join(vaultDir, "ops", "capsules", filename);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const stat = statSync(filePath);

    return {
        slug: filename.replace(/\.md$/, ""),
        title: data.title ?? filename.replace(/\.md$/, "").replace(/-/g, " "),
        description: data.description ?? "",
        isPublic: data.public === true,
        body: content,
        created: data.created ?? null,
        modified: stat.mtime,
    };
}

function listCapsules(vaultDir: string, onlyPublic: boolean): Capsule[] {
    const capsulesDir = join(vaultDir, "ops", "capsules");
    if (!existsSync(capsulesDir)) return [];

    return readdirSync(capsulesDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readCapsule(vaultDir, f))
        .filter((c): c is Capsule => c !== null)
        .filter((c) => !onlyPublic || c.isPublic)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function createCapsulesRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get("/", (c) => {
        const auth = c.get("auth");
        const capsules = listCapsules(vaultDir, !auth.isOwner);

        const list = capsules
            .map(
                (cap) => `
            <li class="py-3 border-b border-gray-800">
                <a href="/capsules/${cap.slug}" class="text-blue-400 hover:text-blue-300 font-medium">${cap.title}</a>
                ${cap.isPublic ? '<span class="ml-2 text-xs px-2 py-0.5 bg-green-900 rounded text-green-400">public</span>' : ""}
                ${cap.description ? `<p class="text-gray-400 text-sm mt-1">${cap.description}</p>` : ""}
            </li>
        `,
            )
            .join("");

        const content = `
            <h1 class="text-2xl font-bold mb-6">Capsules</h1>
            <ul class="bg-gray-900 rounded-lg p-4 border border-gray-800">
                ${list || '<li class="text-gray-500 py-4">No capsules published yet.</li>'}
            </ul>
        `;

        return c.html(
            layout({ title: "Capsules", content, isOwner: auth.isOwner, activeNav: "Capsules" }),
        );
    });

    app.get("/:slug", (c) => {
        const auth = c.get("auth");
        const slug = c.req.param("slug");
        const capsule = readCapsule(vaultDir, `${slug}.md`);

        if (!capsule || (!auth.isOwner && !capsule.isPublic)) {
            return c.html(
                layout({
                    title: "Not Found",
                    content: '<p class="text-gray-500">Capsule not found.</p>',
                    isOwner: auth.isOwner,
                }),
                404,
            );
        }

        const bodyHtml = renderMarkdown(capsule.body);

        const content = `
            <div class="mb-4">
                <a href="/capsules" class="text-gray-500 hover:text-gray-300 text-sm">&larr; All capsules</a>
            </div>
            <article class="bg-gray-900 rounded-lg p-6 border border-gray-800">
                <h1 class="text-2xl font-bold mb-2">${capsule.title}</h1>
                ${capsule.description ? `<p class="text-gray-400 mb-4 italic">${capsule.description}</p>` : ""}
                <div class="prose prose-invert max-w-none">
                    ${bodyHtml}
                </div>
            </article>
            ${
                !auth.isOwner
                    ? `
            <div class="mt-6 bg-gray-900 rounded-lg p-6 border border-purple-800">
                <h3 class="text-lg font-bold mb-2">Fork this capsule</h3>
                <p class="text-gray-400 mb-4">Import this capsule into your own intent computer:</p>
                <code class="block bg-gray-950 px-4 py-2 rounded text-sm text-green-400">
                    intent-computer import ${c.req.url}
                </code>
            </div>
            `
                    : ""
            }
        `;

        return c.html(
            layout({ title: capsule.title, content, isOwner: auth.isOwner, activeNav: "Capsules" }),
        );
    });

    return app;
}
