import { createRealtimeVoiceSessionHarness } from "../../../talk/realtime-session-harness.js";
import { RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS } from "./state.js";

/** Creates the Talk harness for one gateway-relay session. */
export function createTalkRealtimeRelayHarness(relaySessionId: string, providerId: string) {
  return createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: providerId,
      // Keep the pre-harness steering window; other harness consumers use the shared default.
      maxRecentEvents: 20,
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => ({}),
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ reason }),
    },
    transcriptLookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
    captureBridgeEvents: false,
  });
}
