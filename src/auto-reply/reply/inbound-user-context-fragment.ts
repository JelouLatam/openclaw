import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  attachCanonicalHistoryProjection,
  readCanonicalHistorySource,
} from "../../shared/canonical-history.js";
import type { EnvelopeFormatOptions } from "../envelope.js";
import type { TemplateContext } from "../templating.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

/** Preserve full legacy text; only the native session can omit proven retained copies. */
export function buildInboundUserContextFragment(
  ctx: TemplateContext,
  envelope?: EnvelopeFormatOptions,
  sessionEntry?: SessionEntry,
): RuntimeContextFragment {
  const history = ctx.InboundHistory?.slice();
  const snapshot = { ...ctx, InboundHistory: history };
  const fragment: RuntimeContextFragment = {
    kind: "conversation-data",
    text: buildInboundUserContextPrefix(snapshot, envelope, sessionEntry),
  };
  if (history?.some((entry) => readCanonicalHistorySource(entry))) {
    attachCanonicalHistoryProjection(fragment, (retained) => {
      if (buildInboundUserContextPrefix(snapshot, envelope, sessionEntry) !== fragment.text) {
        return fragment.text;
      }
      return buildInboundUserContextPrefix(snapshot, envelope, sessionEntry, retained);
    });
  }
  return fragment;
}
