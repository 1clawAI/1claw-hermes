import { getClient } from "../client.js";
import { VaultError } from "../errors.js";

export interface AuditEvent {
  timestamp: Date;
  agentId: string;
  action: string;
  path: string;
  outcome: "success" | "denied";
}

interface RawAuditEvent {
  timestamp: string;
  actor_id: string;
  action: string;
  resource_id: string;
  detail?: string;
}

function mapEvent(raw: RawAuditEvent): AuditEvent {
  const detail = raw.detail ?? "";
  const outcome: "success" | "denied" =
    detail.includes("denied") || detail.includes("forbidden")
      ? "denied"
      : "success";

  return {
    timestamp: new Date(raw.timestamp),
    agentId: raw.actor_id,
    action: raw.action,
    path: raw.resource_id,
    outcome,
  };
}

export async function recentEvents(limit = 50): Promise<AuditEvent[]> {
  const client = getClient();
  const res = await client.audit.query({ limit });

  if (res.error || !res.data) {
    throw new VaultError(
      "AUDIT_QUERY_FAILED",
      res.error?.message ?? "Failed to query audit events",
    );
  }

  return res.data.events.map(mapEvent);
}

export async function* streamEvents(
  since?: Date,
): AsyncGenerator<AuditEvent> {
  const pageSize = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const client = getClient();
    const res = await client.audit.query({
      limit: pageSize,
      offset,
      from: since?.toISOString(),
    });

    if (res.error || !res.data) {
      throw new VaultError(
        "AUDIT_STREAM_FAILED",
        res.error?.message ?? "Failed to stream audit events",
      );
    }

    const events = res.data.events;
    for (const raw of events) {
      yield mapEvent(raw);
    }

    hasMore = events.length === pageSize;
    offset += events.length;
  }
}
