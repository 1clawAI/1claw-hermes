# @workspace/1claw-hermes

[Hermes Agent](https://hermes-agent.nousresearch.com) runs multi-step workflows with subagents, tools, and shell access. Those agents need API keys and signing keys, but Hermes config files and chat logs are the wrong place to store them.

This package wires [1Claw](https://1claw.xyz) into Hermes across four paths: MCP tools for just-in-time secret fetch, a Shroud sidecar for inspected LLM traffic, scoped subagent identities, and Intents API transaction signing with client-side guardrail checks before anything hits chain.

It is a thin typed layer over `@1claw/sdk` with opinionated defaults for Hermes: bootstrap scripts that enroll an agent by email, atomic config patching, and guardrail validation you can run before submitting a transaction. **Shroud does not turn on by itself.** You either run the [Shroud sidecar](#hermes-and-shroud-use-the-sidecar) in front of Hermes, or call Shroud from TypeScript via [`createShroudClient()`](#route-llm-calls-through-shroud-programmatically).

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

**Long-running setup:** use a process manager so the sidecar survives Hermes restarts and reboots — see **Keep the sidecar running** below.

### Keep the sidecar running

Hermes does not supervise the sidecar. On a **dedicated Hermes machine**, production setups are usually **Linux** (servers, desktops) or **macOS** (developer Macs); both run the same **`pnpm shroud` / `node dist/shroud/sidecar.js`** stack — only the process manager differs.

| Approach | When to use |
|----------|-------------|
| **systemd (user)** | **Linux** — start on login/boot, restart on crash |
| **launchd** | **macOS** — LaunchAgent with `KeepAlive` (see `scripts/shroud-sidecar.launchd.plist.example`) |
| **tmux / screen** | Either OS — quick manual persistence if you do not want a system service yet |
| **Docker / compose** | Either OS — if you already run services in containers |

**Linux (systemd), outline:**

1. In the `1claw-hermes` package: `pnpm install && pnpm build`.
2. Copy `scripts/shroud-sidecar.service.example` to `~/.config/systemd/user/1claw-shroud-sidecar.service` and edit `WorkingDirectory`, `ExecStart` (`node` path), and `Environment=` / `ONECLAW_ENV_FILE` to match your machine.
3. `systemctl --user daemon-reload && systemctl --user enable --now 1claw-shroud-sidecar.service`
4. User units often need **`loginctl enable-linger "$USER"`** so the service can start at boot **without** an interactive login.
5. Check: `curl -s http://127.0.0.1:8080/healthz`

The unit runs **`node dist/shroud/sidecar.js`** (same as `pnpm shroud`): it loads `.env`, may append `ONECLAW_AGENT_ID`, then spawns the `shroud-sidecar` binary.

**macOS (launchd), outline:**

1. Same: `pnpm install && pnpm build` in the `1claw-hermes` package.
2. Copy `scripts/shroud-sidecar.launchd.plist.example` to `~/Library/LaunchAgents/com.1claw.shroud-sidecar.plist` and edit `WorkingDirectory`, absolute path to **`node`** (`which node`), and **`ONECLAW_ENV_FILE`** (see plist comments; create log files with `touch` if you use `StandardOutPath` / `StandardErrorPath`).
3. `launchctl load ~/Library/LaunchAgents/com.1claw.shroud-sidecar.plist` then `launchctl start com.1claw.shroud-sidecar`
4. Check: `curl -s http://127.0.0.1:8080/healthz`

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

## New in v0.43: Automations, Memory, Runtimes & Discovery

### Automations

Schedule recurring tasks for Hermes agents via the 1Claw SDK (`workflow_spec` + cron). Create with a human API key; bind the Hermes agent id:

```ts
import { OneclawClient } from "@1claw/sdk";

const client = new OneclawClient({ apiKey: process.env.ONECLAW_API_KEY! });

await client.automations.create({
  name: "rotate-stripe-key",
  agent_id: process.env.ONECLAW_AGENT_ID!,
  trigger_type: "cron",
  cron_expr: "0 0 * * 0", // weekly
  workflow_spec: {
    steps: [{ type: "secret_rotate", path: "api-keys/stripe" }],
  },
});

const { data } = await client.automations.list();
```

### Agent Memory

Persistent vector memory for Hermes agents — store observations, user preferences, and inter-session context:

```ts
import { storeMemory, searchMemory } from "@workspace/1claw-hermes";

await storeMemory("User prefers concise answers with code examples");
const results = await searchMemory("communication preferences");
```

### Runtimes (1Claw cloud)

Hermes cloud runtimes call `setupHermesRuntime()` via `1claw-hermes-runtime-start`
(`/app/hermes-agent-start.sh`) using `ONECLAW_AGENT_TOKEN` injected by Vault.
Dashboard chat stays on the template chat-bridge; Hermes gateway runs as
`STARTUP_COMMAND` for MCP tools and messaging channels.

```bash
# Inside runtime-hermes container (automatic on start):
1claw-hermes-runtime-start   # patch ~/.hermes MCP + model
hermes gateway               # agent process (default)
```

Environment: `ONECLAW_AGENT_TOKEN`, `ONECLAW_VAULT_ID`, `ONECLAW_SHROUD_ENABLED`,
`LLM_PROVIDER`, `LLM_MODEL`, `HERMES_CONFIG_DIR`.

Programmatic:

```ts
import { setupHermesRuntime, runtimeCredentialsReady } from "@workspace/1claw-hermes";

if (runtimeCredentialsReady()) {
  await setupHermesRuntime();
}
```

### Agent Discovery

Publish Hermes agents to the 1Claw directory:

```ts
import { publishToDirectory } from "@workspace/1claw-hermes";

await publishToDirectory({
  description: "Hermes CMO agent for social media campaigns",
  tags: ["marketing", "social", "hermes"],
});
```

---

## Platform v0.56+ (HITL, HFA, Safe, guardrail governance)

Hermes agents use 1Claw API **v0.58+**. Client-side `validateGuardrails()` still runs before Intents API calls; server-side enforcement adds:

- **Graduated HITL** — Transactions, sign intents, and execution bindings can return `202 awaiting_approval` for human review (dashboard or mobile).
- **Human Factor Auth** — Treasury send/swap passkey step-up when spend policies require it.
- **Guardrail governance** — Shadow/enforce on execution guardrails; widening guardrail PATCHes queue `policy_change` approval; org shadow report + replay APIs.
- **Safe foundation** — Counterfactual Safe agent accounts and module registry (`1claw safe module-registry`).

Multichain signing deps in Vault/Shroud (`rust-bitcoin`, `solana-sdk` v4, `xrpl-rust` 1.1.0) are unchanged — no Hermes package update required for chain support.

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
1claw-hermes-runtime-start  # cloud runtime: patch Hermes from ONECLAW_* env
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
