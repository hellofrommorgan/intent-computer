import type { ID, PipelineTask, Proposition, PropositionLink } from "./domain.js";

export type AuthMode = "api-token" | "oauth-pkce";

export interface TenantScope {
  userId: ID;
  vaultId: ID;
  namespace: string;
}

export interface AuthContext {
  mode: AuthMode;
  subject: string;
  scopes: string[];
  issuedAt: string;
  expiresAt?: string;
  tenant: TenantScope;
}

export interface QueuePatch {
  status?: "pending" | "in-progress" | "done" | "failed";
  phase?: "surface" | "reflect" | "revisit" | "verify";
}

export interface MetadataStorePort {
  upsertProposition(scope: TenantScope, proposition: Proposition): Promise<void>;
  getProposition(scope: TenantScope, propositionId: ID): Promise<Proposition | null>;
  upsertLink(scope: TenantScope, link: PropositionLink): Promise<void>;
  listLinks(scope: TenantScope, propositionId: ID, limit?: number): Promise<PropositionLink[]>;
  enqueue(scope: TenantScope, task: PipelineTask): Promise<void>;
  dequeue(scope: TenantScope): Promise<PipelineTask | null>;
  patchTask(scope: TenantScope, taskId: ID, patch: QueuePatch): Promise<void>;
}

export interface DocumentStorePort {
  putMarkdown(scope: TenantScope, path: string, markdown: string): Promise<void>;
  getMarkdown(scope: TenantScope, path: string): Promise<string | null>;
  listMarkdown(scope: TenantScope, prefix: string): Promise<string[]>;
}

export interface VectorMetadata {
  propositionId: ID;
  title: string;
  topics: string[];
}

export interface VectorSearchHit {
  propositionId: ID;
  score: number;
  excerpt?: string;
}

export interface VectorStorePort {
  upsert(
    scope: TenantScope,
    vectorId: ID,
    embedding: number[],
    metadata: VectorMetadata
  ): Promise<void>;
  hybridSearch(
    scope: TenantScope,
    query: string,
    embedding: number[],
    limit: number
  ): Promise<VectorSearchHit[]>;
  warmNamespace(scope: TenantScope): Promise<void>;
}

export interface SaaSStoragePorts {
  metadata: MetadataStorePort;
  documents: DocumentStorePort;
  vectors: VectorStorePort;
}

export interface AuthPort {
  authenticate(bearerToken: string): Promise<AuthContext>;
}

export interface TenantRouterPort {
  resolve(context: AuthContext): Promise<TenantScope>;
}

// This bundles the three-tier cloud strategy from arscontexta architecture:
// Postgres metadata + object-store markdown + namespace-isolated vectors.
export interface SaaSInfrastructurePorts {
  auth: AuthPort;
  tenantRouter: TenantRouterPort;
  storage: SaaSStoragePorts;
}
