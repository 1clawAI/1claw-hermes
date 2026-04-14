#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  bootstrap,
  bootstrapEnroll,
  completeBootstrapFromEnv,
} from "./bootstrap.js";
import { ConfigError } from "./errors.js";

function usage(): never {
  process.stderr.write(`
Usage: 1claw-hermes-bootstrap [enroll|complete] [options]

Commands:
  (default)     Enroll, then key via --api-key, TTY prompt, or (non-TTY) stub .env + pending_key
  enroll          Only request enrollment and write a stub .env (safe for Hermes / non-TTY)
  complete        Read ONECLAW_AGENT_API_KEY from .env — never pass the key on the CLI

Options (default / enroll / full bootstrap):
  --email <email>     Human operator email (required or prompted)
  --name <name>       Agent name (required or prompted)
  --api-key <key>     Pre-approved ocv_ key (full bootstrap only; avoid — prefer .env + complete)
  --api-base <url>    API base URL (default: https://api.1claw.xyz)
  --env-path <path>   Path to .env file (default: .env in package root)
  --provider <name>   Shroud LLM provider (default: anthropic)

Recommended flow (key never in chat or shell history):
  pnpm bootstrap enroll --email you@x.com --name my-agent
  # Edit .env: set ONECLAW_AGENT_API_KEY=ocv_...
  pnpm bootstrap complete

Fully headless CI (key in secret env, not ideal for humans):
  pnpm bootstrap --email x@y.com --name z --api-key ocv_...

Interactive TTY:
  pnpm bootstrap
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

function shiftArgv(): { cmd: string | undefined; rest: string[] } {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "enroll" || first === "complete" || first === "help") {
    return { cmd: first, rest: argv.slice(1) };
  }
  return { cmd: undefined, rest: argv };
}

async function main(): Promise<void> {
  const { cmd, rest } = shiftArgv();

  if (cmd === "help") usage();

  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "api-key": { type: "string" },
      "api-base": { type: "string" },
      "env-path": { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) usage();

  if (cmd === "complete") {
    const result = await completeBootstrapFromEnv({
      apiBase: values["api-base"],
      envPath: values["env-path"],
      shroudProvider: values.provider,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (cmd === "enroll") {
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

    const result = await bootstrapEnroll({
      email,
      agentName,
      apiBase: values["api-base"],
      envPath: values["env-path"],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

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
