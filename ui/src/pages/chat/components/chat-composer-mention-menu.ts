import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import {
  handleComposerMenuKeydown,
  renderComposerMenu,
  renderComposerMenuOption,
} from "../../../components/composer-menu.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { resolveAgentAvatarUrl } from "../../../lib/avatar.ts";
import {
  NO_AGENT_MENTIONS,
  rankAgentMentions,
  type AgentMentionRoster,
} from "../../../lib/chat/agent-mentions.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import "../../../styles/chat/reply-preview.css";
import "../../../styles/chat/mention-menu.css";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";

export type HumanMentionDirectory = {
  client: GatewayBrowserClient;
  ownerKey: string;
  params: UsersMentionableParams;
};

export type HumanMentionMenuHost = {
  paneId: string;
  getDraft: () => string;
  getMentions: () => readonly HumanMention[];
  getTextarea: () => HTMLTextAreaElement | null;
  commitDraft: (value: string, mentions: readonly HumanMention[]) => void;
};

type MentionTarget = { start: number; end: number; query: string };
type MentionSearch =
  | { kind: "loading" }
  | { kind: "ready"; result: UsersMentionableResult }
  | { kind: "error" };

function findMentionTarget(value: string, caret: number): MentionTarget | null {
  if (value.trimStart().startsWith("/")) {
    return null;
  }
  const beforeCaret = value.slice(0, caret);
  const line = beforeCaret.slice(beforeCaret.lastIndexOf("\n") + 1);
  // Code and quoted examples are text, never people-picker invocations.
  if (
    /^\s*>/u.test(line) ||
    (beforeCaret.match(/```/gu)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/gu)?.length ?? 0) % 2 !== 0
  ) {
    return null;
  }
  const match = /(?:^|[\s([{])@([\p{L}\p{N}\p{M}_.-]{0,64})$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  let end = caret;
  while (end < value.length && /[\p{L}\p{N}\p{M}_.-]/u.test(value[end] ?? "")) {
    end += 1;
  }
  return { start, end, query };
}

function canFilterMentionText(value: string): boolean {
  // Browser and Gateway locales are independent. ASCII without capital I has
  // invariant lowercase; leave locale-sensitive and Unicode matching to the server.
  return /^[\x20-\x7e]*$/u.test(value) && !value.includes("I");
}

/**
 * One bounded suggestion lifecycle shared by existing- and new-session composers.
 * Agents rank locally above the people directory; choosing one inserts plain `@id` text.
 */
export class HumanMentionMenu {
  private directory?: HumanMentionDirectory;
  private agentRoster?: AgentMentionRoster;
  private agents = NO_AGENT_MENTIONS;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private target: MentionTarget | null = null;
  private search: MentionSearch | null = null;
  private index = 0;
  private results = new Map<string, UsersMentionableResult>();

  get open(): boolean {
    return this.target !== null && (this.directory !== undefined || this.agents.matches.length > 0);
  }

  syncDirectory(directory: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (
      this.directory?.client === directory?.client &&
      this.directory?.ownerKey === directory?.ownerKey &&
      JSON.stringify(this.directory?.params) === JSON.stringify(directory?.params)
    ) {
      return;
    }
    this.close();
    this.directory = directory;
  }

  syncAgents(roster: AgentMentionRoster | undefined) {
    if (
      this.agentRoster?.agents === roster?.agents &&
      this.agentRoster?.currentAgentId === roster?.currentAgentId
    ) {
      return;
    }
    this.agentRoster = roster;
    if (this.target) {
      this.index = 0;
      this.agents = rankAgentMentions(roster, this.target.query);
    }
  }

  private cancelSearch() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.index = 0;
  }

  close() {
    this.cancelSearch();
    this.results.clear();
    this.target = null;
    this.search = null;
    this.agents = NO_AGENT_MENTIONS;
  }

  dispose() {
    this.close();
    this.directory = undefined;
    this.agentRoster = undefined;
  }

  private cachedResult(query: string): UsersMentionableResult | undefined {
    const exact = this.results.get(query);
    if (exact) {
      return exact;
    }
    if (!canFilterMentionText(query)) {
      return undefined;
    }
    const normalizedQuery = query.toLowerCase();
    for (const [prefix, result] of this.results) {
      // Gateway matches names before adding duplicate-name ID suffixes. Opaque matches
      // (for example a server-only ID lookup) and ambiguous labels must refetch;
      // exact queries keep the server response unchanged, including truncated results.
      if (
        !result.truncated &&
        query.startsWith(prefix) &&
        result.users.every(
          (person) =>
            canFilterMentionText(person.displayName) &&
            person.displayName.toLowerCase().includes(prefix.toLowerCase()) &&
            !person.displayName.endsWith(` (${person.profileId.slice(0, 8)})`),
        )
      ) {
        return {
          users: result.users.filter((person) =>
            person.displayName.toLowerCase().includes(normalizedQuery),
          ),
          truncated: false,
        };
      }
    }
    return undefined;
  }

  update(value: string, caret: number, requestUpdate: () => void, typedAtSign = false) {
    const target = this.directory || this.agentRoster ? findMentionTarget(value, caret) : null;
    if (!target || (!this.target && !typedAtSign)) {
      if (this.target) {
        this.close();
        requestUpdate();
      }
      return;
    }
    if (this.target?.start === target.start && this.target.query === target.query) {
      return;
    }
    if (this.target?.start !== target.start) {
      this.results.clear();
    }
    this.cancelSearch();
    this.target = target;
    this.agents = rankAgentMentions(this.agentRoster, target.query);
    const query = target.query;
    if (!this.directory) {
      this.search = null;
      requestUpdate();
      return;
    }
    const cached = this.cachedResult(query);
    if (cached) {
      this.search = { kind: "ready", result: cached };
      requestUpdate();
      return;
    }
    this.search = { kind: "loading" };
    const directory = this.directory;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void directory.client
        .request<UsersMentionableResult>("users.mentionable", {
          ...directory.params,
          query: target.query,
        })
        .then(
          (result) => {
            if (generation === this.generation) {
              if (this.results.size === 16) {
                this.results.delete(this.results.keys().next().value!);
              }
              this.results.set(query, result);
              this.search = { kind: "ready", result };
              requestUpdate();
            }
          },
          () => {
            if (generation === this.generation) {
              this.search = { kind: "error" };
              requestUpdate();
            }
          },
        );
    }, 150);
    requestUpdate();
  }

  private people(): UsersMentionableResult["users"] {
    return this.search?.kind === "ready" ? this.search.result.users : [];
  }

  activeId(paneId: string): string | null {
    const agentCount = this.agents.matches.length;
    if (this.index < agentCount) {
      return paneDomId(paneId, `mention-agent-option-${this.index}`);
    }
    return this.people()[this.index - agentCount]
      ? paneDomId(paneId, `mention-option-${this.index - agentCount}`)
      : null;
  }

  activeLabel(): string {
    const agentCount = this.agents.matches.length;
    return this.index < agentCount
      ? this.agents.matches[this.index]!.label
      : (this.people()[this.index - agentCount]?.displayName ?? "");
  }

  handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return false;
    }
    const agents = this.agents.matches;
    const users = this.people();
    return handleComposerMenuKeydown(event, {
      count: agents.length + users.length,
      index: this.index,
      consumeEmpty: true,
      close: () => {
        this.close();
        requestUpdate();
      },
      move: (index) => {
        this.index = index;
        requestUpdate();
        return this.activeId(host.paneId);
      },
      select: () => this.select(this.index, host, requestUpdate),
    });
  }

  private select(index: number, host: HumanMentionMenuHost, requestUpdate: () => void) {
    const match = this.agents.matches[index];
    const person = this.people()[index - this.agents.matches.length];
    if (match) {
      this.insert(`@${match.agent.id}`, undefined, host, requestUpdate);
    } else if (person) {
      this.insert(`@${person.displayName}`, person.profileId, host, requestUpdate);
    }
  }

  /** Only a person carries a profile id; an agent mention stays plain text with no recipient. */
  private insert(
    label: string,
    profileId: string | undefined,
    host: HumanMentionMenuHost,
    requestUpdate: () => void,
  ) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    const target = findMentionTarget(current, textarea?.selectionStart ?? current.length);
    if (!target || (profileId && host.getMentions().length >= MAX_HUMAN_MENTIONS)) {
      return;
    }
    const replacement = `${label} `;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const mentions = updateHumanMentions(current, next, host.getMentions(), {
      value: current,
      start: target.start,
      end: target.end,
      inputType: "insertReplacementText",
    });
    host.commitDraft(
      next,
      profileId
        ? [
            ...mentions,
            { profileId, start: target.start, end: target.start + label.length },
          ].toSorted((a, b) => a.start - b.start)
        : mentions,
    );
    this.close();
    requestUpdate();
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(
        target.start + replacement.length,
        target.start + replacement.length,
      );
    });
  }

  private renderOption(
    index: number,
    host: HumanMentionMenuHost,
    requestUpdate: () => void,
    option: { id: string; icon: unknown; name: string; description: unknown },
  ) {
    return renderComposerMenuOption({
      id: paneDomId(host.paneId, option.id),
      active: index === this.index,
      select: () => this.select(index, host, requestUpdate),
      hover: () => {
        this.index = index;
        requestUpdate();
      },
      icon: option.icon,
      iconHidden: true,
      name: option.name,
      description: option.description,
    });
  }

  private renderAgents(host: HumanMentionMenuHost, requestUpdate: () => void) {
    const { matches, overflow } = this.agents;
    if (matches.length === 0) {
      return nothing;
    }
    return html`<div class="slash-menu-group">
      <div class="slash-menu-group__label">${t("chat.mentions.agents")}</div>
      ${matches.map(({ agent, label }, index) =>
        this.renderOption(index, host, requestUpdate, {
          id: `mention-agent-option-${index}`,
          icon: renderChatAuthorAvatar({
            id: agent.id,
            name: label,
            identity: { type: "agent", id: agent.id },
            profileAvatarUrl: resolveAgentAvatarUrl(agent) ?? undefined,
          }),
          name: label,
          description: `@${agent.id}`,
        }),
      )}
      ${
        overflow > 0
          ? html`<div class="slash-menu-group__label">
              ${t("chat.mentions.agentsMore", { count: String(overflow) })}
            </div>`
          : nothing
      }
    </div>`;
  }

  render(host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open) {
      return nothing;
    }
    const agents = this.renderAgents(host, requestUpdate);
    if (!this.directory) {
      return renderComposerMenu({
        id: paneDomId(host.paneId, "mention-menu-listbox"),
        className: "mention-menu",
        label: t("chat.mentions.agents"),
        trackScroll: false,
        content: agents,
      });
    }
    const offset = this.agents.matches.length;
    const result = this.search?.kind === "ready" ? this.search.result : undefined;
    const limited = host.getMentions().length >= MAX_HUMAN_MENTIONS;
    const loading = this.search?.kind === "loading";
    const message = limited
      ? t("chat.mentions.limit")
      : this.search?.kind === "error"
        ? t("chat.mentions.unavailable")
        : !loading && !result?.users.length
          ? t("chat.mentions.empty")
          : null;
    return renderComposerMenu({
      id: paneDomId(host.paneId, "mention-menu-listbox"),
      className: "mention-menu",
      label: offset > 0 ? t("chat.mentions.menuWithAgents") : t("chat.mentions.menu"),
      trackScroll: false,
      content: html`${agents}
        <div class="slash-menu-group" aria-busy=${loading}>
          <div class="slash-menu-group__label" role="status">
            ${message ?? t("chat.mentions.menu")}
          </div>
          ${
            message
              ? nothing
              : loading
                ? html`<div class="slash-menu-item mention-menu__loading" aria-hidden="true">
                    <span class="slash-menu-icon"
                      ><span class="skeleton mention-menu__avatar"></span
                    ></span>
                    <span class="skeleton skeleton-line skeleton-line--medium"></span>
                  </div>`
                : result?.users.map((person, index) =>
                    this.renderOption(offset + index, host, requestUpdate, {
                      id: `mention-option-${index}`,
                      icon: renderChatAuthorAvatar({
                        id: person.profileId,
                        name: person.displayName,
                        identity: { type: "profile", id: person.profileId },
                        profileAvatarUrl: person.avatarUrl,
                      }),
                      name: person.displayName,
                      description: person.online ? t("chat.mentions.online") : nothing,
                    }),
                  )
          }
          ${
            result?.truncated
              ? html`<div class="slash-menu-group__label">${t("chat.mentions.truncated")}</div>`
              : nothing
          }
        </div>`,
    });
  }
}

export function renderSelectedHumanMentions(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  onRemove: () => void,
) {
  if (!mentions?.length) {
    return nothing;
  }
  const names = mentions.map((mention) => text.slice(mention.start, mention.end)).join(", ");
  return html`<div class="chat-reply-preview" role="status">
    <span class="chat-reply-preview__icon" aria-hidden="true">${icons.users}</span>
    <span class="chat-reply-preview__text">${t("chat.mentions.selected", { names })}</span>
    <button
      type="button"
      class="chat-reply-preview__dismiss"
      aria-label=${t("chat.mentions.remove")}
      @click=${onRemove}
    >
      ${icons.x}
    </button>
  </div>`;
}
