const DEFAULT_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_CONFIGURABLE_PAYLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Resolve the authenticated frame ceiling. OPENCLAW_GATEWAY_MAX_PAYLOAD_MB can only raise
 * the default: chat attachments travel base64 inside one frame, so any
 * agents.defaults.mediaMaxMb above ~18.5 MB is unreachable until the frame grows with it.
 */
export function resolveGatewayMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_GATEWAY_MAX_PAYLOAD_MB?.trim();
  const mb = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(mb)) {
    return DEFAULT_MAX_PAYLOAD_BYTES;
  }
  return Math.min(
    MAX_CONFIGURABLE_PAYLOAD_BYTES,
    Math.max(DEFAULT_MAX_PAYLOAD_BYTES, Math.floor(mb * 1024 * 1024)),
  );
}

// Keep server maxPayload aligned with gateway client maxPayload so high-res canvas snapshots
// don't get disconnected mid-invoke with "Max payload size exceeded".
export const MAX_PAYLOAD_BYTES = resolveGatewayMaxPayloadBytes();
export const MAX_BUFFERED_BYTES = MAX_PAYLOAD_BYTES * 2; // per-connection send buffer limit (2x max payload)
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;
export const WEBSOCKET_OPEN_READY_STATE = 1;
export const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
// Keep the consecutive lazy-load and async-handshake ingress queues equally bounded.
export const MAX_QUEUED_GATEWAY_PREAUTH_FRAMES = 16;

const DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
const maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;

export const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;
export const TICK_INTERVAL_MS = 30_000;
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;
