/**
 * Build graph data for the force-directed vault visualization.
 * Scans all thoughts, extracts wiki links, and returns nodes + edges.
 */

import { listThoughts, type VaultThought } from "./vault-reader.js";
import { titleToSlug } from "./markdown.js";

export interface GraphNode {
    id: string;     // slugified title
    title: string;  // original title
    type: string;   // frontmatter type or "thought"
}

export interface GraphEdge {
    source: string; // slugified title of the linking thought
    target: string; // slugified title of the linked thought
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

/**
 * Scan all thoughts in the vault and build a graph of nodes and edges.
 * Nodes are thoughts; edges are wiki links between them.
 */
export function buildGraphData(vaultDir: string): GraphData {
    const thoughts = listThoughts(vaultDir);
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;

    // Build a set of known slugs for filtering edges to real nodes
    const knownSlugs = new Set<string>();
    const nodeMap = new Map<string, GraphNode>();

    for (const thought of thoughts) {
        const slug = thought.slug;
        knownSlugs.add(slug);
        nodeMap.set(slug, {
            id: slug,
            title: thought.title,
            type: thought.type ?? "thought",
        });
    }

    const nodes: GraphNode[] = Array.from(nodeMap.values());
    const edges: GraphEdge[] = [];
    const seenEdges = new Set<string>();

    for (const thought of thoughts) {
        const sourceSlug = thought.slug;

        // Extract wiki links from the body
        let match: RegExpExecArray | null;
        wikiLinkRegex.lastIndex = 0;
        while ((match = wikiLinkRegex.exec(thought.body)) !== null) {
            const linkedTitle = match[1];
            const targetSlug = titleToSlug(linkedTitle);

            // Only include edges to known thoughts
            if (knownSlugs.has(targetSlug) && targetSlug !== sourceSlug) {
                const edgeKey = `${sourceSlug}->${targetSlug}`;
                if (!seenEdges.has(edgeKey)) {
                    seenEdges.add(edgeKey);
                    edges.push({ source: sourceSlug, target: targetSlug });
                }
            }
        }

        // Also extract wiki links from frontmatter topics
        for (const topic of thought.topics) {
            const topicMatch = /\[\[([^\]]+)\]\]/.exec(topic);
            if (topicMatch) {
                const targetSlug = titleToSlug(topicMatch[1]);
                if (knownSlugs.has(targetSlug) && targetSlug !== sourceSlug) {
                    const edgeKey = `${sourceSlug}->${targetSlug}`;
                    if (!seenEdges.has(edgeKey)) {
                        seenEdges.add(edgeKey);
                        edges.push({ source: sourceSlug, target: targetSlug });
                    }
                }
            }
        }
    }

    return { nodes, edges };
}
