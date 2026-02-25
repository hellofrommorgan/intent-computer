/**
 * Base HTML layout template.
 * Uses Tailwind CSS via CDN and htmx for interactive updates.
 * No build step, no SPA — server-side rendered HTML.
 */

export function layout(opts: {
    title: string;
    content: string;
    isOwner: boolean;
    activeNav?: string;
}): string {
    const nav = (label: string, href: string) => {
        const active = opts.activeNav === label
            ? 'class="text-white font-semibold border-b-2 border-white pb-1"'
            : 'class="text-gray-300 hover:text-white"';
        return `<a href="${href}" ${active}>${label}</a>`;
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${opts.title} — intent computer</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <style>
        .prose a { color: #3b82f6; text-decoration: underline; }
        .prose a:hover { color: #60a5fa; }
        .wiki-link { color: #8b5cf6; font-weight: 500; }
        .wiki-link:hover { color: #a78bfa; }
    </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
    <nav class="bg-gray-900 border-b border-gray-800 px-4 py-3">
        <div class="max-w-4xl mx-auto flex items-center gap-6">
            <a href="/" class="text-lg font-bold text-white tracking-tight">
                intent computer
            </a>
            ${opts.isOwner ? `
            <div class="flex gap-4 text-sm">
                ${nav("Dashboard", "/")}
                ${nav("Thoughts", "/thoughts")}
                ${nav("Inbox", "/inbox")}
                ${nav("Brief", "/morning-brief")}
                ${nav("Graph", "/graph")}
                ${nav("Capsules", "/capsules")}
            </div>
            ` : `
            <div class="flex gap-4 text-sm">
                ${nav("Capsules", "/capsules")}
            </div>
            `}
        </div>
    </nav>
    <main class="max-w-4xl mx-auto px-4 py-8">
        ${opts.content}
    </main>
</body>
</html>`;
}
