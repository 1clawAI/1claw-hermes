# @workspace/1claw-hermes

Integration package that wires [1Claw](https://1claw.xyz) secrets management into [Hermes Agent](https://hermes-agent.nousresearch.com) across four planes: MCP-based secret fetching, Shroud LLM proxy, per-subagent scoped identities, and Intents API transaction signing. Every LLM call routes through Shroud's TEE for automatic secret redaction, PII filtering, and injection scoring before reaching the upstream provider.

This package is designed as a thin, typed layer over the `@1claw/sdk`. It provides opinionated defaults for Hermes workflows — ephemeral subagent identities with scoped policies, client-side guardrail validation before on-chain transactions, and atomic Hermes config patching — while staying composable enough to use in any agent framework that speaks the OpenAI chat completions API.

## Quick Start (Bootstrap)

**Recommended (Hermes, CI shells, non-TTY):** keep the API key out of chat and off the command line. Enroll once, paste the key only into `.env` on disk, then complete:

```bash
cd packages/1claw-hermes
pnpm install
pnpm bootstrap enroll --email alice@acme.com --name my-hermes-agent
# Approve the email, then edit .env and set:
#   ONECLAW_AGENT_API_KEY=ocv_...
pnpm bootstrap complete
```

`complete` reads `ONECLAW_AGENT_API_KEY` from the file — it never prompts for the secret.

Aliases: `pnpm bootstrap:enroll` and `pnpm bootstrap:complete`.

**Interactive terminal (TTY):** one-shot flow with a paste prompt after enrollment:

```bash
pnpm bootstrap --email alice@acme.com --name my-hermes-agent
```

**Same behavior as `enroll` + `complete` in non-TTY:** running `pnpm bootstrap --email … --name …` without a TTY (e.g. Hermes running a shell command) writes a stub `.env` with an empty `ONECLAW_AGENT_API_KEY=` line and prints instructions. JSON stdout includes `"status":"pending_key"`. After you fill the key in the file, run `pnpm bootstrap complete`.

**CI only (key already in a secret store):** avoid logging this; prefer injecting into `.env` and using `pnpm bootstrap complete`.

```bash
pnpm bootstrap --email alice@acme.com --name my-agent --api-key ocv_abc123
```

Programmatic two-phase:

```ts
import {
  needsBootstrap,
  bootstrapEnroll,
  completeBootstrapFromEnv,
} from "@workspace/1claw-hermes";

if (needsBootstrap()) {
  await bootstrapEnroll({ email: "alice@acme.com", agentName: "my-hermes-agent" });
  // user adds ONECLAW_AGENT_API_KEY to .env
  await completeBootstrapFromEnv();
}
```

## Installation (Manual)

If you prefer to configure manually instead of using bootstrap:

```bash
cd packages/1claw-hermes
cp .env.example .env
# fill in ONECLAW_AGENT_API_KEY (everything else is auto-discovered or has defaults)
pnpm install && pnpm build
```

## Configuration

All environment variables are validated at startup with Zod. The only variable strictly required for operation is `ONECLAW_AGENT_API_KEY` — everything else is auto-discovered or has sensible defaults.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ONECLAW_AGENT_API_KEY` | Yes | — | `ocv_` prefixed agent API key |
| `ONECLAW_VAULT_ID` | No | auto-discovered | UUID of the vault to operate on |
| `ONECLAW_API_BASE` | No | `https://api.1claw.xyz` | Vault API base URL |
| `ONECLAW_MCP_URL` | No | `https://mcp.1claw.xyz/mcp` | MCP server endpoint |
| `ONECLAW_MCP_TOKEN` | No | — | Pre-exchanged JWT (auto-exchanged if blank) |
| `SHROUD_URL` | No | `https://shroud.1claw.xyz/v1` | Shroud TEE proxy URL |
| `SHROUD_TOKEN` | No | uses agent JWT | Bearer token for Shroud |
| `SHROUD_PROVIDER` | No | `anthropic` | Upstream LLM provider |
| `HERMES_CONFIG_DIR` | No | `~/.hermes` | Path to Hermes config directory |

For test isolation, use `loadConfig()` with partial overrides:

```ts
import { loadConfig } from "@workspace/1claw-hermes";
const cfg = loadConfig({ ONECLAW_AGENT_API_KEY: "ocv_test" });
```

## Patch Hermes config

Register 1Claw under `mcp_servers.oneclaw` (tools: `mcp_oneclaw_*`):

```ts
import { patchHermesConfig } from "@workspace/1claw-hermes";
await patchHermesConfig("~/.hermes");
```

**Default (`stdio`) — recommended:** writes a **stdio** server that runs `npx -y @1claw/mcp` with `ONECLAW_AGENT_API_KEY`, `ONECLAW_VAULT_ID`, and `ONECLAW_BASE_URL` in `env`. The official MCP package **refreshes JWTs inside the process** on every request, so you are **not** embedding expiring Bearer tokens in YAML. After `bootstrap`, one patch + `/reload-mcp` and you are done.

**Optional HTTP (`transport: 'http'`):** talks to `https://mcp.1claw.xyz/mcp` with `Authorization: Bearer <JWT>` and `X-Vault-ID`. JWTs expire (often ~15–60 minutes); re-run `patchHermesConfig("~/.hermes", { transport: "http" })` when auth fails.

```ts
await patchHermesConfig("~/.hermes", { transport: "http" });
```

Files touched:

- **`~/.hermes/config.yaml`** when it exists or when creating fresh config (Hermes native).
- **`~/.hermes/config.json`** only if YAML is missing and JSON already exists.

Stdio mode stores your `ocv_` key in the YAML `env` block (same sensitivity as `.env` — keep `~/.hermes` permissions tight).

**Apply in Hermes** (no full restart required):

```text
/reload-mcp
```

See [MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/) and [Use MCP with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/).

## Route LLM calls through Shroud

Get an OpenAI-compatible client pointed at the Shroud TEE proxy. Shroud intercepts every request — redacting secrets and PII, scoring for prompt injection — then forwards to the real provider.

```ts
import { createShroudClient } from "@workspace/1claw-hermes";

const llm = createShroudClient();
const res = await llm.chat.completions.create({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Run the Stripe balance check" }],
});
```

Log Shroud inspection results from response headers:

```ts
import { logShroudResponse } from "@workspace/1claw-hermes";
// after a raw fetch to Shroud:
logShroudResponse(response.headers);
```

## Fetch secrets via MCP tools

Typed wrappers over the 1Claw MCP tools. Never store resolved values — use them inline.

```ts
import { getSecret, setSecret, listSecrets } from "@workspace/1claw-hermes";

const apiKey = await getSecret("api-keys/stripe");
await setSecret("api-keys/new-service", "sk_live_...");
const paths = await listSecrets("api-keys/");
```

All functions accept an optional `AgentContext` for subagent-scoped calls:

```ts
const value = await getSecret("config/db-url", {
  agentId: identity.agentId,
  token: identity.vaultToken,
});
```

## Provision a subagent

Create an ephemeral 1Claw agent identity with scoped access, and tear it down on exit:

```ts
import {
  provisionSubagent,
  ephemeralReadPolicy,
  deprovisionSubagent,
} from "@workspace/1claw-hermes";

const identity = await provisionSubagent(
  "stripe-checker",
  ephemeralReadPolicy("api-keys/stripe"),
);
// pass identity.vaultToken to the subagent process

// on exit:
await deprovisionSubagent(identity.agentId);
```

Build custom policies with the fluent `PolicyBuilder`:

```ts
import { PolicyBuilder } from "@workspace/1claw-hermes";

const policy = new PolicyBuilder()
  .allowPath("api-keys/*")
  .allowPath("config/db-*")
  .readOnly()
  .expireAfter(600)
  .allowChains("base", "ethereum")
  .capValue("0.1")
  .build();
```

The `SubagentRegistry` tracks all live identities and cleans up on `SIGTERM`:

```ts
import { SubagentRegistry } from "@workspace/1claw-hermes";
const registry = new SubagentRegistry();
// ... provision agents with registry ...
await registry.revokeAll(); // clean shutdown
```

## Sign an on-chain transaction

Submit transaction intents through the 1Claw Intents API with client-side guardrail validation:

```ts
import { submitIntent, validateIntent } from "@workspace/1claw-hermes";

const intent = { to: "0x...", value: "0.01", chain: "base" };
validateIntent(intent, agentPolicy); // throws GuardrailViolationError if invalid
const result = await submitIntent(agentId, intent);
console.log(result.explorerUrl);
```

`validateIntent` checks chain allowlists, value caps, and address restrictions before any network call. Errors have machine-readable `code` fields: `CHAIN_NOT_ALLOWED`, `VALUE_EXCEEDS_CAP`, `ADDRESS_NOT_ALLOWED`.

## Query audit logs

```ts
import { recentEvents, streamEvents } from "@workspace/1claw-hermes";

const events = await recentEvents(20);
for await (const event of streamEvents(new Date("2026-01-01"))) {
  console.log(event.action, event.path, event.outcome);
}
```

## Development

```bash
pnpm dev          # watch mode
pnpm test         # run all tests
pnpm test:watch   # watch mode
pnpm build        # compile to dist/
pnpm bootstrap              # TTY: full flow; non-TTY: stub .env + pending_key
pnpm bootstrap:enroll       # enroll + stub .env only
pnpm bootstrap:complete     # read key from .env, merge vault id
```

## Architecture

```
src/
  config.ts          — Zod-validated env + runtime config, needsBootstrap() helper
  client.ts          — Singleton @1claw/sdk wrapper with auto token refresh
  errors.ts          — Typed error classes (ConfigError, VaultError, GuardrailViolationError)
  bootstrap.ts       — enroll stub, complete-from-.env, full bootstrap; parseDotEnv
  bootstrap-cli.ts   — CLI: enroll | complete | default (TTY / non-TTY pending_key)
  mcp/
    index.ts         — buildMcpEntry (JWT + vault)
    hermes-config.ts — patchHermesConfig → config.yaml mcp_servers.oneclaw
    tools.ts         — Typed wrappers for 1Claw MCP tools (getSecret, setSecret, listSecrets)
  shroud/
    index.ts         — OpenAI-compatible Shroud proxy client factory
    middleware.ts     — Response header parser for redaction/injection logging
  subagents/
    index.ts         — Subagent identity lifecycle (provision, deprovision, registry)
    policy.ts        — Fluent policy builder with ephemeral read preset
  intents/
    index.ts         — Intents API wrapper for on-chain transaction signing
    guardrails.ts    — Client-side guardrail validation (chain, value, address)
  audit/
    index.ts         — Audit log query helpers with cursor-based streaming
  index.ts           — Public API barrel exports
```
