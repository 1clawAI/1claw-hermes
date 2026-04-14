# @workspace/1claw-hermes

Integration package that wires [1Claw](https://1claw.xyz) secrets management into [Hermes Agent](https://hermes-agent.nousresearch.com) across four planes: MCP-based secret fetching, optional Shroud LLM proxy, per-subagent scoped identities, and Intents API transaction signing. **Shroud does not turn on by itself:** you either run the [Shroud sidecar](#hermes-and-shroud-use-the-sidecar) in front of Hermes, or call Shroud from TypeScript via [`createShroudClient()`](#route-llm-calls-through-shroud-programmatically).

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
| `ONECLAW_AGENT_ID` | No | auto-written on `bootstrap complete` | Agent UUID — **required** by the raw `shroud-sidecar` binary; `pnpm shroud` can append it via token exchange if missing |
| `ONECLAW_ENV_FILE` | No | — | Absolute path to `.env` when it is not next to this package (cloud / custom layout). Same as `pnpm shroud --env-file` / `pnpm setup --env-path` |
| `ONECLAW_VAULT_ID` | No | auto-discovered | UUID of the vault to operate on |
| `ONECLAW_API_BASE` | No | `https://api.1claw.xyz` | Vault API base URL |
| `ONECLAW_MCP_URL` | No | `https://mcp.1claw.xyz/mcp` | MCP server endpoint |
| `ONECLAW_MCP_TOKEN` | No | — | Pre-exchanged JWT (auto-exchanged if blank) |
| `SHROUD_URL` | No | `https://shroud.1claw.xyz/v1` | Shroud TEE proxy URL (`createShroudClient` in Node) |
| `SHROUD_TOKEN` | No | uses agent JWT | Bearer for Shroud (`createShroudClient`); not used by the sidecar binary |
| `SHROUD_PROVIDER` | No | `anthropic` | Upstream for `createShroudClient` only — **Hermes + sidecar** uses `ONECLAW_DEFAULT_PROVIDER` on the **sidecar** process ([below](#hermes-and-shroud-use-the-sidecar)) |
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

## Hermes and Shroud: use the sidecar

Hermes's **custom** OpenAI-compatible provider only sends a **base URL + API key**. Shroud expects extra headers (`X-Shroud-Provider`, agent auth). The supported pattern is to run the **[1claw Shroud sidecar](https://github.com/1clawAI/1claw-shroud-sidecar)** on your machine, point Hermes at `localhost`, and let the sidecar inject headers and forward to `https://shroud.1claw.xyz`.

### One command (after bootstrap)

```bash
pnpm setup --provider google
```

This does **everything**:

1. Reads `ONECLAW_AGENT_API_KEY` from `.env` (runs `bootstrap complete` if vault ID is missing).
2. Patches `~/.hermes/config.yaml` → `mcp_servers.oneclaw` (stdio MCP with auto-refreshing JWT).
3. Patches `~/.hermes/config.yaml` → `model.provider: custom`, `model.base_url: http://127.0.0.1:8080/v1`.
4. Downloads + installs the sidecar binary (if not on PATH).
5. Starts the sidecar → waits for `/healthz` → prints "ready".
6. Keeps running (Ctrl+C to stop).

Switch back to Hermes and run `/reload-mcp`. Done.

### Hermes restart vs the sidecar

**Hermes and the sidecar are two different processes.** `pnpm setup` patches Hermes to use `model.base_url: http://127.0.0.1:8080/v1`, but **Hermes does not start or supervise the sidecar**. If you restart Hermes (or your machine) and nothing is listening on port **8080**, chat will fail with `APIConnectionError` / connection refused until you start the sidecar again.

**Quick fix after a restart:** from the `1claw-hermes` package directory, run `pnpm shroud` (or `pnpm setup` again) so the sidecar is up, then use Hermes as usual.

**Long-running setup:** run the sidecar under **systemd**, **Docker**, **tmux**, or your process manager so it survives Hermes restarts. See `scripts/shroud-sidecar.service.example` for a systemd user unit (after `pnpm build`, point `WorkingDirectory` and optional `ONECLAW_ENV_FILE` at your paths).

### Which `.env` file?

`pnpm setup` and `pnpm shroud` resolve credentials in this order:

1. CLI flag: `--env-path` (setup) or `--env-file` (shroud)
2. Environment variable: `ONECLAW_ENV_FILE=/absolute/path/.env`
3. Walk **current working directory** upward until a file named `.env` is found (so you can `cd` into `~/hermes/hermes-agent/1claw-hermes` and run `pnpm shroud` with no extra flags)
4. Fallback: `packages/1claw-hermes/.env` next to this package

The Go binary **`shroud-sidecar` does not read `.env` files** — either run **`pnpm shroud`** (Node loads the file and passes env vars to the child), or `set -a; source /path/.env; set +a` before `./shroud-sidecar`. After `pnpm bootstrap complete`, `.env` includes **`ONECLAW_AGENT_ID`** when the API returns it; if you have an older file with only `ocv_`, run `pnpm shroud` once — it may **append** the agent id automatically.

Options:

```bash
pnpm setup --provider openai                                   # different upstream
pnpm setup --provider google --model google/gemini-2.5-flash   # also set model name
pnpm setup --no-sidecar                                        # patch configs only, start sidecar yourself
pnpm setup --sidecar-port 9090                                 # non-default port
pnpm setup -h                                                  # full help
```

### Step-by-step alternative

If you want more control (or `pnpm setup` isn't right for your environment):

**Start just the sidecar** (reads credentials from `.env`):

```bash
pnpm shroud                                    # install + start sidecar from .env
ONECLAW_DEFAULT_PROVIDER=google pnpm shroud    # set provider explicitly
```

**Patch Hermes model config** (point at sidecar) separately from TS:

```ts
import { patchHermesModel } from "@workspace/1claw-hermes";
await patchHermesModel("~/.hermes");
// or with options:
await patchHermesModel("~/.hermes", {
  sidecarBaseUrl: "http://127.0.0.1:9090/v1",
  model: "google/gemini-2.5-flash",
});
```

**Undo model patching** (stop routing through sidecar):

```ts
import { unpatchHermesModel } from "@workspace/1claw-hermes";
await unpatchHermesModel("~/.hermes");
```

**Programmatic sidecar** from your own Node process:

```ts
import { startSidecarAndWait } from "@workspace/1claw-hermes";
const child = await startSidecarAndWait({ provider: "google" });
// child is a ChildProcess; kill it when done
```

### What often goes wrong

| Symptom | Cause |
|--------|--------|
| `APIConnectionError` / "Connection error" to `http://localhost:8080/v1` | Sidecar **not running**, wrong port, or Hermes and sidecar on **different hosts** (VM/Docker without port publish). Fix: run `pnpm shroud` in another terminal, or `pnpm setup` to do everything. |
| Putting `SHROUD_PROVIDER` under `mcp_servers.oneclaw.env` | That block configures **only the MCP subprocess** (secrets/tools). It does **not** affect Hermes's **model** HTTP client. Set provider on the **sidecar process** (`ONECLAW_DEFAULT_PROVIDER`) or via `pnpm setup --provider`. |
| MCP works, chat fails | Expected: two different processes — MCP has env from YAML; LLM uses `model.base_url` only. The sidecar must be running for LLM traffic. |

### Docker / remote note

If Hermes runs **inside** a container, `localhost:8080` is **inside that container**. Run the sidecar in the same network namespace, publish `8080:8080`, or point `base_url` at `host.docker.internal:8080` (or the host IP) as appropriate.

---

## Route LLM calls through Shroud (programmatically)

From **TypeScript/Node** (not the Hermes binary), use `createShroudClient()` — it sets `X-Shroud-Provider` from `SHROUD_PROVIDER` and talks to `SHROUD_URL` (default `https://shroud.1claw.xyz/v1`). This path does **not** require the sidecar.

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

## Vault secrets (SDK REST, same semantics as MCP)

Typed wrappers call the **Vault HTTP API** via `@1claw/sdk` (with the same agent key / JWT refresh as the rest of this package). The MCP server exposes the same operations as tools named `get_secret`, **`put_secret`**, `list_secrets` — there is no separate "MCP protocol" for secrets; names differ only at the tool layer.

- **`setSecret`** = **`putSecret`** = `PUT /v1/vaults/{vaultId}/secrets/{path}` (alias exported for parity with MCP naming).
- Pass **`{ type: "api_key" }`** when you want the same behaviour as MCP auto-detection for API keys.

Never persist resolved secret values in code — load them inline when needed.

```ts
import { getSecret, setSecret, putSecret, listSecrets } from "@workspace/1claw-hermes";

const apiKey = await getSecret("api-keys/stripe");
await setSecret("api-keys/new-service", "sk_live_...", { type: "api_key" });
await putSecret("passwords/other", "secret-value"); // same as setSecret

const paths = await listSecrets("api-keys/");
```

**Requirements:** `ONECLAW_VAULT_ID` and `ONECLAW_AGENT_API_KEY` must be set in the process environment (same as the MCP stdio server). If the REST call fails while MCP works, the process running this code often **does not have the same env** as the MCP subprocess — align `.env` / Hermes `mcp_servers.oneclaw.env` with the app using these helpers.

`getSecret` / `listSecrets` accept an optional `AgentContext` for subagent-scoped calls:

```ts
const value = await getSecret("config/db-url", {
  agentId: identity.agentId,
  token: identity.vaultToken,
});
```

For **`setSecret`**, pass a subagent either as the third argument **alone** (legacy: `{ agentId, token }`) or inside options:

```ts
await setSecret("path", "value", { ctx: { agentId, token }, type: "api_key" });
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
pnpm setup                  # patch Hermes + start sidecar (after bootstrap)
pnpm shroud                 # start sidecar only (from .env)
```

## Architecture

```
src/
  config.ts          — Zod-validated env + runtime config, needsBootstrap() helper
  client.ts          — Singleton @1claw/sdk wrapper with auto token refresh
  dotenv-path.ts     — resolveDotEnvPath (ONECLAW_ENV_FILE, cwd walk, package .env)
  errors.ts          — Typed error classes (ConfigError, VaultError, GuardrailViolationError)
  bootstrap.ts       — enroll stub, complete-from-.env, full bootstrap; parseDotEnv; ensureAgentIdInDotEnv
  bootstrap-cli.ts   — CLI: enroll | complete | default (TTY / non-TTY pending_key)
  setup.ts           — Unified CLI: bootstrap complete → patch MCP → patch model → start sidecar
  mcp/
    index.ts         — buildMcpEntry (JWT + vault)
    hermes-config.ts — patchHermesConfig, patchHermesModel, unpatchHermesModel → config.yaml
    tools.ts         — REST-backed secret helpers (getSecret, setSecret/putSecret, listSecrets)
  shroud/
    index.ts         — OpenAI-compatible Shroud proxy client factory (createShroudClient)
    sidecar.ts       — Install, start, and health-check the shroud-sidecar Go binary
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
