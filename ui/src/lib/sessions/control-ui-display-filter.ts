import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_HIDDEN_SESSION_PREFIXES_ATTRIBUTE } from "../../../../src/gateway/control-ui-bootstrap-contract.js";

/** A browser presentation rule. Gateway session access and channel delivery are unchanged. */
export function readHiddenSessionKeyPrefixes(): string[] {
  const raw = globalThis.document?.documentElement.getAttribute(
    CONTROL_UI_HIDDEN_SESSION_PREFIXES_ATTRIBUTE,
  );
  if (!raw) {
    return [];
  }
  try {
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function hidden(key: unknown, prefixes: readonly string[]): boolean {
  return typeof key === "string" && prefixes.some((prefix) => key.startsWith(prefix));
}

export function filterControlUiSessionResponse<T>(
  method: string,
  result: T,
  prefixes: readonly string[],
  canAdmin: boolean,
): T {
  if (canAdmin || prefixes.length === 0 || !isRecord(result)) {
    return result;
  }
  if (method === "sessions.list" && Array.isArray(result.sessions)) {
    const sessions = result.sessions.filter((row) => !isRecord(row) || !hidden(row.key, prefixes));
    return { ...result, sessions, count: sessions.length } as T;
  }
  if (method === "sessions.search") {
    if (!Array.isArray(result.sessions) && !Array.isArray(result.results)) {
      return result;
    }
    return {
      ...result,
      ...(Array.isArray(result.sessions)
        ? {
            sessions: result.sessions.filter((row) => !isRecord(row) || !hidden(row.key, prefixes)),
          }
        : {}),
      ...(Array.isArray(result.results)
        ? {
            results: result.results.filter(
              (hit) => !isRecord(hit) || !hidden(hit.sessionKey, prefixes),
            ),
          }
        : {}),
    } as T;
  }
  return result;
}
