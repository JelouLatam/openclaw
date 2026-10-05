// Delivery mirrors keep the files a channel send carried as managed attachments for the Control UI.
import { appendAssistantMessageToSessionTranscript } from "../config/sessions.js";
import { getAgentScopedMediaLocalRootsForSources } from "../media/local-roots.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  removeManagedOutgoingMediaBlocks,
} from "./managed-image-attachments.js";

type DeliveryMirrorAppendParams = Parameters<typeof appendAssistantMessageToSessionTranscript>[0];

function isRemoteMediaUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/** Falls back to the text-only mirror when no sent file can be prepared again. */
export async function appendDeliveryMirrorToSessionTranscript(
  params: DeliveryMirrorAppendParams,
): ReturnType<typeof appendAssistantMessageToSessionTranscript> {
  const mediaUrls = Array.from(
    new Set(params.mediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  const sessionKey = params.sessionKey.trim();
  // Remote URLs are not re-fetched after delivery; only files the send read locally are kept.
  const localMediaUrls = mediaUrls.filter((url) => !isRemoteMediaUrl(url));
  if (!sessionKey || localMediaUrls.length === 0 || params.displayContent?.length) {
    return await appendAssistantMessageToSessionTranscript(params);
  }
  const localRoots = getAgentScopedMediaLocalRootsForSources({
    cfg: params.config ?? {},
    agentId: params.agentId,
    mediaSources: localMediaUrls,
  });
  const mediaBlocks: Awaited<ReturnType<typeof createManagedOutgoingMediaBlocks>> = [];
  for (const url of localMediaUrls) {
    try {
      mediaBlocks.push(
        ...(await createManagedOutgoingMediaBlocks({
          sessionKey,
          agentId: params.agentId,
          // The channel send already read this file under the agent's media access.
          items: [{ url, trustedLocal: true }],
          localRoots,
        })),
      );
    } catch {
      // A file that cannot be read back stays in the transcript text only.
    }
  }
  if (mediaBlocks.length === 0) {
    return await appendAssistantMessageToSessionTranscript(params);
  }
  const caption = params.text?.trim();
  let committed = false;
  try {
    return await appendAssistantMessageToSessionTranscript({
      ...params,
      mediaUrls,
      displayContent: [...(caption ? [{ type: "text", text: caption }] : []), ...mediaBlocks],
      onMessageCommitted: (result, acceptCompletion) => {
        committed = result.appended;
        if (result.appended) {
          acceptCompletion(async () => {
            if (
              !(await attachManagedOutgoingMediaToMessage({
                messageId: result.messageId,
                blocks: mediaBlocks,
              }))
            ) {
              throw new Error("Delivery mirror media ownership could not be persisted");
            }
          });
        }
        params.onMessageCommitted?.(result, acceptCompletion);
      },
    });
  } finally {
    if (!committed) {
      await removeManagedOutgoingMediaBlocks({ blocks: mediaBlocks, messageId: null });
    }
  }
}
