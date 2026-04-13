import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { config } from "../config.js";
import { getClient } from "../client.js";
import { VaultError } from "../errors.js";

export interface McpServerEntry {
  url: string;
  headers: { Authorization: string; "X-Vault-ID": string };
}

export function buildMcpEntry(
  token: string,
  vaultId: string,
): McpServerEntry {
  return {
    url: config.oneClawMcpUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Vault-ID": vaultId,
    },
  };
}

function resolveHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export async function patchHermesConfig(configDir: string): Promise<void> {
  const resolved = resolveHome(configDir);
  const configPath = path.join(resolved, "config.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    await fs.promises.mkdir(resolved, { recursive: true });
  }

  const backupPath = path.join(
    resolved,
    `config.json.bak.${Date.now()}`,
  );
  if (Object.keys(existing).length > 0) {
    await fs.promises.writeFile(
      backupPath,
      JSON.stringify(existing, null, 2),
      "utf-8",
    );
  }

  const client = getClient();
  const tokenResponse = await client.auth.agentToken({
    api_key: config.oneClawAgentApiKey,
  });

  if (tokenResponse.error || !tokenResponse.data) {
    throw new VaultError(
      "TOKEN_EXCHANGE_FAILED",
      tokenResponse.error?.message ?? "Failed to exchange agent token",
    );
  }

  const entry = buildMcpEntry(
    tokenResponse.data.access_token,
    config.oneClawVaultId,
  );

  const mcpServers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const merged = {
    ...existing,
    mcpServers: { ...mcpServers, "1claw": entry },
  };

  const tmpPath = configPath + ".tmp";
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify(merged, null, 2),
    "utf-8",
  );
  await fs.promises.rename(tmpPath, configPath);
}
