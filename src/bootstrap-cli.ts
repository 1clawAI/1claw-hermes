#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.js";
import { ConfigError } from "./errors.js";

function usage(): never {
  process.stderr.write(`
Usage: 1claw-hermes-bootstrap [options]

Options:
  --email <email>     Human operator email (required or prompted)
  --name <name>       Agent name (required or prompted)
  --api-key <key>     Pre-approved ocv_ API key (skips email approval wait)
  --api-base <url>    API base URL (default: https://api.1claw.xyz)
  --env-path <path>   Path to write .env file (default: .env in package root)
  --provider <name>   Shroud LLM provider (default: anthropic)
  --help              Show this help message

Interactive mode:
  1claw-hermes-bootstrap
  (prompts for email, agent name, and API key)

Headless mode:
  1claw-hermes-bootstrap --email alice@acme.com --name my-agent
  (prompts only for API key after email approval)

Fully headless:
  1claw-hermes-bootstrap --email alice@acme.com --name my-agent --api-key ocv_...
  (zero prompts — for CI or pre-approved agents)
`);
  process.exit(0);
}

async function promptLine(query: string): Promise<string> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email:    { type: "string" },
      name:     { type: "string" },
      "api-key": { type: "string" },
      "api-base": { type: "string" },
      "env-path": { type: "string" },
      provider: { type: "string" },
      help:     { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) usage();

  let email = values.email;
  let agentName = values.name;

  if (!email) {
    if (!process.stdin.isTTY) {
      process.stderr.write("Error: --email is required in non-interactive mode\n");
      process.exit(1);
    }
    email = await promptLine("Your 1Claw account email: ");
  }

  if (!agentName) {
    if (!process.stdin.isTTY) {
      process.stderr.write("Error: --name is required in non-interactive mode\n");
      process.exit(1);
    }
    agentName = await promptLine("Agent name: ");
  }

  if (!email || !agentName) {
    process.stderr.write("Error: email and agent name are required\n");
    process.exit(1);
  }

  const result = await bootstrap({
    email,
    agentName,
    apiKey: values["api-key"],
    apiBase: values["api-base"],
    envPath: values["env-path"],
    shroudProvider: values.provider,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`Error: ${err.message}\n`);
  } else {
    process.stderr.write(`Unknown error: ${String(err)}\n`);
  }
  process.exit(1);
});
