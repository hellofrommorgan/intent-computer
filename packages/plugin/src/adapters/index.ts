/**
 * adapters/index.ts — barrel export for local filesystem adapters
 *
 * Each adapter implements a port interface from @intent-computer/architecture
 * using the local vault filesystem as its backing store.
 */

export { LocalPerceptionAdapter } from "./local-perception.js";
export { LocalIdentityAdapter } from "./local-identity.js";
export { LocalCommitmentAdapter } from "./local-commitment.js";
export { LocalMemoryAdapter } from "./local-memory.js";
export { LocalExecutionAdapter } from "./local-execution.js";
export { LocalPipelineAdapter } from "./local-pipeline.js";
