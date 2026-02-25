import type { ID, Proposition } from "./domain.js";

export const INTENT_COMPUTER_MCP_TOOLS = [
  "vault_context",
  "inbox_capture",
  "thought_search",
  "thought_get",
  "thought_write",
  "link_graph",
  "queue_push",
  "queue_pop",
] as const;

export type IntentComputerMcpTool = (typeof INTENT_COMPUTER_MCP_TOOLS)[number];

export interface VaultContextRequest {
  vaultId: ID;
  sessionId: ID;
  includeIdentity?: boolean;
  includeGoals?: boolean;
  includeMaintenance?: boolean;
}

export interface VaultContextResponse {
  context: string;
  maintenanceSignals: string[];
  generatedAt: string;
}

export interface InboxCaptureRequest {
  vaultId: ID;
  source: string;
  title: string;
  body: string;
  tags?: string[];
}

export interface InboxCaptureResponse {
  itemId: ID;
  path: string;
}

export interface ThoughtSearchRequest {
  vaultId: ID;
  query: string;
  limit?: number;
}

export interface ThoughtSearchHit {
  proposition: Proposition;
  score: number;
  excerpt?: string;
}

export interface ThoughtSearchResponse {
  hits: ThoughtSearchHit[];
}

export interface ThoughtGetRequest {
  vaultId: ID;
  thoughtId: ID;
}

export interface ThoughtWriteRequest {
  vaultId: ID;
  proposition: Proposition;
  markdown: string;
}

export interface ThoughtWriteResponse {
  thoughtId: ID;
  path: string;
  version: string;
}

export interface LinkGraphRequest {
  vaultId: ID;
  thoughtId?: ID;
  limit?: number;
}

export interface LinkGraphEdge {
  sourceId: ID;
  targetId: ID;
  relation: string;
  confidence?: number;
}

export interface LinkGraphResponse {
  edges: LinkGraphEdge[];
}

export interface QueuePushRequest {
  vaultId: ID;
  target: string;
  sourcePath: string;
  phase: "surface" | "reflect" | "revisit" | "verify";
}

export interface QueuePushResponse {
  taskId: ID;
}

export interface QueuePopRequest {
  vaultId: ID;
  lockTtlSeconds?: number;
}

export interface QueuePopResponse {
  taskId: ID;
  target: string;
  sourcePath: string;
  phase: "surface" | "reflect" | "revisit" | "verify";
}

// The SaaS MCP boundary intentionally avoids LLM calls: storage + retrieval only.
export interface IntentComputerMcpApi {
  vaultContext(request: VaultContextRequest): Promise<VaultContextResponse>;
  inboxCapture(request: InboxCaptureRequest): Promise<InboxCaptureResponse>;
  thoughtSearch(request: ThoughtSearchRequest): Promise<ThoughtSearchResponse>;
  thoughtGet(request: ThoughtGetRequest): Promise<Proposition | null>;
  thoughtWrite(request: ThoughtWriteRequest): Promise<ThoughtWriteResponse>;
  linkGraph(request: LinkGraphRequest): Promise<LinkGraphResponse>;
  queuePush(request: QueuePushRequest): Promise<QueuePushResponse>;
  queuePop(request: QueuePopRequest): Promise<QueuePopResponse | null>;
}

