# @workspace/1claw-hermes

Integration package that wires [1Claw](https://1claw.xyz) secrets management into [Hermes Agent](https://hermes-agent.nousresearch.com) across four planes: MCP-based secret fetching, Shroud LLM proxy, per-subagent scoped identities, and Intents API transaction signing. Every LLM call routes through Shroud's TEE for automatic secret redaction, PII filtering, and injection scoring before reaching the upstream provider.

This package is designed as a thin, typed layer over the `@1claw/sdk`. It provides opinionated defaults for Hermes workflows — ephemeral subagent identities with scoped policies, client-side guardrail validation before on-chain transactions, and atomic Hermes config patching — while staying composable enough to use in any agent framework that speaks the OpenAI chat completions API.

## Quick Start (Bootstrap)

The fastest way to get running — just provide your email and an agent name:

```bash
cd packages/1claw-hermes
pnpm install
pnpm bootstrap --email alice@acme.com --name my-hermes-agent
```

This will:
1. Self-enroll an agent via the 1Claw API (no account setup needed)
2. Send an approval email to the address you provided
3. Prompt you to paste the `ocv_` API key from the approval email
4. Auto-discover your agent ID and vault from the API key
5. Write a `.env` file with everything configured

For CI or pre-approved agents, pass the key directly:

```bash
pnpm bootstrap --email alice@acme.com --name my-agent --api-key ocv_abc123
```

Or bootstrap programmatically at runtime:

```ts
import { needsBootstrap, bootstrap } from "@workspace/1claw-hermes";

if (needsBootstrap()) {
  await bootstrap({ email: "alice@acme.com", agentName: "my-hermes-agent" });
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

Register the 1Claw MCP server so Hermes loads it on boot:

```ts
import { patchHermesConfig } from "@workspace/1claw-hermes";
await patchHermesConfig("~/.hermes");
// Restart Hermes — it will now load the 1Claw MCP server
```

This reads the existing `config.json`, creates a timestamped backup, exchanges an agent token, merges the MCP server entry, and writes back atomically.

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
pnpm bootstrap    # interactive setup wizard
```

## Architecture

```
src/
  config.ts          — Zod-validated env + runtime config, needsBootstrap() helper
  client.ts          — Singleton @1claw/sdk wrapper with auto token refresh
  errors.ts          — Typed error classes (ConfigError, VaultError, GuardrailViolationError)
  bootstrap.ts       — Core enrollment + auto-discovery + .env writing engine
  bootstrap-cli.ts   — CLI entry point (interactive / headless / fully headless)
  mcp/
    index.ts         — MCP server config builder + Hermes config patcher
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
