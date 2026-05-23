# Product Context — for CMO Draft Prompts

Distilled from the 1claw-mcp README so the talent has accurate facts
when it writes posts. Update whenever the product README changes.

## Main repo

- `github.com/1clawAI/1claw-mcp` — primary CTA target
- License: open source (verify before reposting)
- Stars / downloads / contributors: pull live before stat-brag posts

## What it does

MCP (Model Context Protocol) server that gives AI agents secure
just-in-time access to secrets from the 1claw vault, plus a
standalone security inspection pipeline that flags malicious LLM
input/output.

## Killer claims (use verbatim or close to it)

- "Secrets fetched at runtime, never persisted in LLM context."
- "Just-in-time access to secrets."
- "Values are never logged."
- "No hardcoded credentials."
- "Tool calls inspected — clean or malicious."
- "Secret redaction with opaque tokens before reaching LLM context."
- "Shroud: advanced server-side security in a TEE."

## Who it's for

- AI agents that need credential access (Claude, Cursor, local models)
- Security-conscious orgs running LLM apps
- Local-model users (Ollama, LM Studio) who want threat detection
  without setting up a full vault

## Deployment modes

- **Local stdio** — Claude Desktop, Cursor, Hermes
- **Hosted HTTP** — `mcp.1claw.xyz`
- **Local-only mode** — `ONECLAW_LOCAL_ONLY=true` gives you the
  `inspect_content` tool without needing a 1claw account

## Install copy

```
npx -y @1claw/mcp
```

Required env vars for the connected vault mode:
`ONECLAW_AGENT_ID`, `ONECLAW_AGENT_API_KEY`, `ONECLAW_VAULT_ID`.

## 30+ tools spread across:

- Secret management (get / put / list)
- Transaction signing
- Wallet provisioning
- Content inspection (prompt-injection, PII, exfiltration)

## Adjacent products to cross-promote occasionally

- `1claw-hermes` — TypeScript glue for Hermes Agent
- `1claw-shroud-sidecar` — TEE-backed LLM proxy

## Anti-claims (don't say)

- Don't promise "100% secure" or "uncrackable."
- Don't claim the threat verdicts catch novel attacks not in the rules.
- Don't compare ourselves to Vault / 1Password / Doppler by name in
  posts. Compare patterns ("`.env` files", "shared API keys"), not
  products.
