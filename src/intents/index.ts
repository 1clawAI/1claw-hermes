import { getClient } from "../client.js";
import { VaultError } from "../errors.js";

export interface TransactionIntent {
  to: string;
  value: string;
  chain: string;
  data?: string;
}

export interface TransactionResult {
  txHash: string;
  chain: string;
  explorerUrl: string;
  simulated: boolean;
}

const EXPLORER_URLS: Record<string, string> = {
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  sepolia: "https://sepolia.etherscan.io/tx/",
  "base-sepolia": "https://sepolia.basescan.org/tx/",
};

function buildExplorerUrl(chain: string, txHash: string): string {
  const base = EXPLORER_URLS[chain] ?? `https://etherscan.io/tx/`;
  return `${base}${txHash}`;
}

export async function submitIntent(
  agentId: string,
  intent: TransactionIntent,
): Promise<TransactionResult> {
  const client = getClient();

  const res = await client.agents.submitTransaction(agentId, {
    to: intent.to,
    value: intent.value,
    chain: intent.chain,
    data: intent.data,
    simulate_first: true,
  });

  if (res.error || !res.data) {
    throw new VaultError(
      "TX_SUBMIT_FAILED",
      res.error?.message ?? "Transaction submission failed",
    );
  }

  const tx = res.data;
  const txHash = tx.tx_hash ?? tx.id;

  return {
    txHash,
    chain: intent.chain,
    explorerUrl: buildExplorerUrl(intent.chain, txHash),
    simulated: tx.simulation_status === "success",
  };
}
