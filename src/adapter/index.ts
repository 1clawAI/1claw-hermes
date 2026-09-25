export {
  createAdapterServer,
  startAdapter,
  handleRequest,
  toHermesRequest,
  buildCompletionResponse,
  buildChunk,
  flattenContent,
  newCompletionId,
  sseData,
  SSE_DONE,
  type AdapterOptions,
  type StartedAdapter,
  type OpenAiChatMessage,
  type OpenAiChatCompletionRequest,
} from "./openai-sse-adapter.js";

export {
  SubprocessHermesDriver,
  type HermesDriver,
  type HermesGenerateRequest,
  type HermesGenerateResult,
  type HermesChatMessage,
  type HermesStreamEvent,
  type SpawnLike,
  type SubprocessHermesDriverOptions,
} from "./hermes-driver.js";

export {
  ADAPTER_DEFAULT_PORT,
  ADAPTER_DEFAULT_HOST,
  resolveAdapterEnv,
  type AdapterEnvConfig,
} from "./serve.js";
