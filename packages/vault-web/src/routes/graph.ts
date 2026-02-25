/**
 * Graph route — GET /graph
 *
 * Returns an HTML page with a force-directed graph visualization.
 * Uses D3.js from CDN. Each node is a thought, each edge is a wiki link.
 * Nodes are clickable and link to /thoughts/:slug.
 * Dark theme to match the layout.
 */

import { Hono } from "hono";
import { buildGraphData } from "../lib/graph-data.js";
import { layout } from "../templates/layout.js";
import type { AppEnv } from "../middleware/auth.js";

export function createGraphRoute(vaultDir: string): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.get("/", (c) => {
        const auth = c.get("auth");
        if (!auth.isOwner) return c.text("Unauthorized", 401);

        const graphData = buildGraphData(vaultDir);
        const graphJson = JSON.stringify(graphData);

        // Color map for thought types
        const typeColors: Record<string, string> = {
            reflection: "#8b5cf6",
            insight: "#3b82f6",
            observation: "#10b981",
            connection: "#f59e0b",
            tension: "#ef4444",
            intention: "#ec4899",
            thought: "#6b7280",
        };

        const content = `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-2xl font-bold">Knowledge Graph</h1>
                <span class="text-gray-500">${graphData.nodes.length} nodes, ${graphData.edges.length} edges</span>
            </div>
            <div id="graph-container" class="bg-gray-900 rounded-lg border border-gray-800" style="height: 600px; position: relative;">
                ${graphData.nodes.length === 0
                    ? '<p class="text-gray-500 p-6">No thoughts yet. Create some thoughts to see the graph.</p>'
                    : ""}
            </div>
            <div class="mt-4 flex gap-4 flex-wrap text-xs">
                ${Object.entries(typeColors)
                    .map(([type, color]) => `
                        <div class="flex items-center gap-1">
                            <span class="inline-block w-3 h-3 rounded-full" style="background: ${color}"></span>
                            <span class="text-gray-400">${type}</span>
                        </div>
                    `)
                    .join("")}
            </div>

            <script src="https://d3js.org/d3.v7.min.js"></script>
            <script>
            (function() {
                const data = ${graphJson};
                if (data.nodes.length === 0) return;

                const container = document.getElementById("graph-container");
                const width = container.clientWidth;
                const height = container.clientHeight;

                const typeColors = ${JSON.stringify(typeColors)};

                const svg = d3.select("#graph-container")
                    .append("svg")
                    .attr("width", width)
                    .attr("height", height)
                    .attr("viewBox", [0, 0, width, height]);

                // Add zoom behavior
                const g = svg.append("g");
                svg.call(d3.zoom()
                    .scaleExtent([0.2, 4])
                    .on("zoom", (event) => g.attr("transform", event.transform)));

                const simulation = d3.forceSimulation(data.nodes)
                    .force("link", d3.forceLink(data.edges).id(d => d.id).distance(80))
                    .force("charge", d3.forceManyBody().strength(-200))
                    .force("center", d3.forceCenter(width / 2, height / 2))
                    .force("collision", d3.forceCollide().radius(20));

                // Draw edges
                const link = g.append("g")
                    .selectAll("line")
                    .data(data.edges)
                    .join("line")
                    .attr("stroke", "#374151")
                    .attr("stroke-opacity", 0.6)
                    .attr("stroke-width", 1);

                // Draw nodes
                const node = g.append("g")
                    .selectAll("g")
                    .data(data.nodes)
                    .join("g")
                    .style("cursor", "pointer")
                    .on("click", (event, d) => {
                        window.location.href = "/thoughts/" + d.id;
                    })
                    .call(d3.drag()
                        .on("start", (event, d) => {
                            if (!event.active) simulation.alphaTarget(0.3).restart();
                            d.fx = d.x;
                            d.fy = d.y;
                        })
                        .on("drag", (event, d) => {
                            d.fx = event.x;
                            d.fy = event.y;
                        })
                        .on("end", (event, d) => {
                            if (!event.active) simulation.alphaTarget(0);
                            d.fx = null;
                            d.fy = null;
                        }));

                node.append("circle")
                    .attr("r", 6)
                    .attr("fill", d => typeColors[d.type] || typeColors.thought);

                node.append("title")
                    .text(d => d.title);

                // Labels for nodes with fewer neighbors (avoid clutter)
                node.append("text")
                    .text(d => d.title.length > 30 ? d.title.slice(0, 30) + "..." : d.title)
                    .attr("x", 10)
                    .attr("y", 4)
                    .attr("font-size", "10px")
                    .attr("fill", "#9ca3af")
                    .attr("pointer-events", "none");

                simulation.on("tick", () => {
                    link
                        .attr("x1", d => d.source.x)
                        .attr("y1", d => d.source.y)
                        .attr("x2", d => d.target.x)
                        .attr("y2", d => d.target.y);

                    node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
                });
            })();
            </script>
        `;

        return c.html(
            layout({ title: "Graph", content, isOwner: true, activeNav: "Graph" }),
        );
    });

    return app;
}
