/**
 * Render markdown to HTML with wiki link resolution.
 * Wiki links [[thought title]] become clickable links to /thoughts/slug.
 */

import { marked } from "marked";

/**
 * Convert a thought title to a URL slug.
 * "the anxiety before speaking is the same anxiety before writing"
 * → "the-anxiety-before-speaking-is-the-same-anxiety-before-writing"
 */
export function titleToSlug(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Resolve wiki links in markdown before rendering.
 * [[thought title]] → <a href="/thoughts/slug" class="wiki-link">thought title</a>
 */
function resolveWikiLinks(md: string): string {
    return md.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
        const slug = titleToSlug(title);
        return `<a href="/thoughts/${slug}" class="wiki-link">[[${title}]]</a>`;
    });
}

export function renderMarkdown(md: string): string {
    const resolved = resolveWikiLinks(md);
    return marked.parse(resolved) as string;
}
