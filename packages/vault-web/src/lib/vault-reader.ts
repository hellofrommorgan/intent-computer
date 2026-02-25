/**
 * Reads vault files directly from the filesystem.
 * Parses YAML frontmatter and returns structured data.
 * No caching — the filesystem IS the source of truth.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";

export interface VaultThought {
    slug: string;           // filename without .md
    title: string;          // frontmatter title or filename
    description: string;    // frontmatter description
    type: string | null;    // frontmatter type
    topics: string[];       // frontmatter topics (raw strings)
    body: string;           // markdown body
    created: string | null; // frontmatter created date
    modified: Date;         // file mtime
}

export interface VaultFile {
    name: string;
    content: string;
    modified: Date;
}

export function readThought(vaultDir: string, slug: string): VaultThought | null {
    const filePath = join(vaultDir, "thoughts", `${slug}.md`);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const stat = statSync(filePath);

    return {
        slug,
        title: data.title ?? slug.replace(/-/g, " "),
        description: data.description ?? "",
        type: data.type ?? null,
        topics: Array.isArray(data.topics) ? data.topics : [],
        body: content,
        created: data.created ?? null,
        modified: stat.mtime,
    };
}

export function listThoughts(vaultDir: string): VaultThought[] {
    const thoughtsDir = join(vaultDir, "thoughts");
    if (!existsSync(thoughtsDir)) return [];

    return readdirSync(thoughtsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readThought(vaultDir, f.replace(/\.md$/, "")))
        .filter((t): t is VaultThought => t !== null)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function readVaultFile(vaultDir: string, relativePath: string): VaultFile | null {
    const filePath = join(vaultDir, relativePath);
    if (!existsSync(filePath)) return null;

    return {
        name: basename(filePath),
        content: readFileSync(filePath, "utf-8"),
        modified: statSync(filePath).mtime,
    };
}

export function countInboxItems(vaultDir: string): number {
    const inboxDir = join(vaultDir, "inbox");
    if (!existsSync(inboxDir)) return 0;
    return readdirSync(inboxDir).filter((f) => f.endsWith(".md")).length;
}
