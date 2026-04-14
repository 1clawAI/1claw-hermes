export { loadConfig, needsBootstrap, requireVaultId, requireApiKey, type Config } from "./config.js";
export { getClient } from "./client.js";
export {
  bootstrap,
  bootstrapEnroll,
  completeBootstrapFromEnv,
  parseDotEnv,
  isBootstrapComplete,
  type BootstrapOptions,
  type BootstrapResult,
  type BootstrapCompleteResult,
  type BootstrapPendingResult,
  type EnrollOnlyOptions,
  type CompleteFromEnvOptions,
} from "./bootstrap.js";
export {
  buildMcpEntry,
  patchHermesConfig,
  buildHermesMcpServerEntry,
  HERMES_ONECLAW_SERVER_KEY,
  type HermesHttpMcpEntry,
} from "./mcp/index.js";
export { getSecret, setSecret, listSecrets } from "./mcp/tools.js";
export type { AgentContext } from "./mcp/tools.js";
export { createShroudClient } from "./shroud/index.js";
export { logShroudResponse } from "./shroud/middleware.js";
export type { ShroudResponseInfo, LogFn } from "./shroud/middleware.js";
export {
  provisionSubagent,
  deprovisionSubagent,
  SubagentRegistry,
} from "./subagents/index.js";
export type { SubagentIdentity } from "./subagents/index.js";
export { PolicyBuilder, ephemeralReadPolicy } from "./subagents/policy.js";
export type { AgentPolicy } from "./subagents/policy.js";
export {
  submitIntent,
  type TransactionIntent,
  type TransactionResult,
} from "./intents/index.js";
export { validateIntent } from "./intents/guardrails.js";
export { GuardrailViolationError } from "./errors.js";
export {
  recentEvents,
  streamEvents,
  type AuditEvent,
} from "./audit/index.js";
export { VaultError, ConfigError } from "./errors.js";
