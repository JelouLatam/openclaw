import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { agentRosterCards } from "../lib/agents/roster-activity.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { filterVisibleSessionRows } from "../lib/sessions/index.ts";
import { resolveUiDefaultAgentId } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { tokenizeSearchQuery } from "./app-sidebar-session-search-match.ts";
import {
  flattenSessionSearch,
  rankSessionSearch,
  type FlatSessionSearchHit,
  type SessionSearchCandidate,
  type SessionSearchGroup,
  type SessionSearchHit,
} from "./app-sidebar-session-search-rank.ts";
import type {
  SidebarRecentSession,
  SidebarRosterLayout,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import "../styles/app-sidebar-session-search.css";

const SESSION_SEARCH_REMOTE_DELAY_MS = 250;
const SESSION_SEARCH_REMOTE_MIN_CHARS = 2;
const SESSION_SEARCH_REMOTE_LIMIT = 40;
const RESULTS_ID = "sidebar-session-search-results";
const OPTION_ID_PREFIX = "sidebar-session-search-option-";
const EDITABLE_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox']";

export type SidebarSessionSearchHost = {
  setRosterLayout(layout: SidebarRosterLayout): void;
  selectSession(sessionKey: string): void;
  openMainSession(agentId: string): void;
};

/** Membership the sidebar list applies; loaded and Gateway rows must match it too. */
export type SidebarSessionSearchScope = {
  statusFilter: SidebarSessionStatusFilter;
  showCron: boolean;
  showSystem: boolean;
  involvingMe: boolean;
  ownerId: string | null;
};

type SearchCandidate = SessionSearchCandidate & { row: SidebarRecentSession };
type SearchOption = { kind: "agent"; agentId: string } | { kind: "session"; key: string };
type SearchResults =
  | { flat: true; hits: FlatSessionSearchHit<SearchCandidate>[] }
  | { flat: false; groups: SessionSearchGroup<SearchCandidate>[] };
type RemoteResult = {
  client: unknown;
  search: string;
  scopeKey: string;
  rows: readonly GatewaySessionRow[];
};

function scopeKey(scope: SidebarSessionSearchScope): string {
  return JSON.stringify([scope.statusFilter, scope.involvingMe]);
}

function searchOptions(results: SearchResults): SearchOption[] {
  const session = (hit: SessionSearchHit<SearchCandidate>): SearchOption => ({
    kind: "session",
    key: hit.session.key,
  });
  return results.flat
    ? results.hits.map(session)
    : results.groups.flatMap((group) => [
        { kind: "agent", agentId: group.agentId } as const,
        ...group.sessions.map(session),
      ]);
}

function remoteHitCount(results: SearchResults): number {
  const hits = results.flat ? results.hits : results.groups.flatMap((group) => group.sessions);
  return hits.filter((hit) => hit.remote).length;
}

function longestToken(tokens: readonly string[]): string {
  return tokens.reduce((best, token) => (token.length > best.length ? token : best), "");
}

function renderHighlighted(text: string, positions: readonly number[] | undefined) {
  if (!positions?.length) {
    return text;
  }
  const marked = new Set(positions);
  const parts: unknown[] = [];
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (run) {
      parts.push(runMarked ? html`<mark class="sidebar-session-search__mark">${run}</mark>` : run);
    }
    run = "";
  };
  Array.from(text).forEach((char, index) => {
    if (marked.has(index) !== runMarked) {
      flush();
      runMarked = !runMarked;
    }
    run += char;
  });
  flush();
  return parts;
}

class SidebarSessionSearch extends OpenClawLightDomElement {
  @property({ attribute: false }) host!: SidebarSessionSearchHost;
  @property({ attribute: false }) query = "";
  @property({ attribute: false }) onQueryChange: (query: string) => void = () => undefined;
  @property({ attribute: false }) active = true;
  @property({ attribute: false }) agentsMode: "chip" | "roster" = "chip";
  @property({ attribute: false }) layout: SidebarRosterLayout = "flat";
  @property({ attribute: false }) rows: readonly SidebarRecentSession[] = [];
  @property({ attribute: false }) toSidebarSession?: (
    row: GatewaySessionRow,
  ) => SidebarRecentSession;
  @property({ attribute: false }) scope: SidebarSessionSearchScope = {
    statusFilter: "active",
    showCron: false,
    showSystem: false,
    involvingMe: false,
    ownerId: null,
  };
  @property({ attribute: false }) showPreview = false;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private cursor = 0;
  @state() private remote: RemoteResult | null = null;
  private readonly avatars = new IdentityAvatarController(this);
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteRequest = 0;
  private pendingRemote: { search: string; scopeKey: string } | null = null;
  private results: SearchResults | null = null;
  private options: SearchOption[] = [];
  private remoteCount = 0;
  private scrollCursorIntoView = false;

  constructor() {
    super();
    new SubscriptionsController(this)
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentIdentity,
        (identity, notify) => identity.subscribe(notify),
      )
      // One-agent workspaces search every agent: hold the shared cross-agent
      // window only while a query needs it.
      .watch(
        () =>
          this.active && this.context && this.agentsMode === "chip" && this.searching
            ? rosterActivityStore(this.context)
            : undefined,
        (store, notify) => store.subscribe(notify),
      );
  }

  private get searching(): boolean {
    return this.query.trim().length > 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleGlobalKeydown, true);
  }

  override disconnectedCallback() {
    window.removeEventListener("keydown", this.handleGlobalKeydown, true);
    this.cancelRemoteSearch();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("query")) {
      this.cursor = 0;
    }
    if (changed.has("query") || changed.has("scope") || changed.has("active")) {
      this.syncRemoteSearch();
    }
    this.results = this.searching ? this.rankResults() : null;
    this.options = this.results ? searchOptions(this.results) : [];
    this.remoteCount = this.results ? remoteHitCount(this.results) : 0;
    this.cursor = Math.min(this.cursor, Math.max(0, this.options.length - 1));
  }

  protected override updated() {
    if (this.scrollCursorIntoView) {
      this.scrollCursorIntoView = false;
      this.querySelector(`#${OPTION_ID_PREFIX}${this.cursor}`)?.scrollIntoView({
        block: "nearest",
      });
    }
  }

  private cancelRemoteSearch() {
    if (this.remoteTimer !== null) {
      clearTimeout(this.remoteTimer);
      this.remoteTimer = null;
    }
    this.remoteRequest += 1;
    this.pendingRemote = null;
  }

  private syncRemoteSearch() {
    const search = longestToken(tokenizeSearchQuery(this.query));
    const key = scopeKey(this.scope);
    if (!this.active || search.length < SESSION_SEARCH_REMOTE_MIN_CHARS) {
      this.cancelRemoteSearch();
      this.remote = null;
      return;
    }
    if (this.remote && this.remote.scopeKey !== key) {
      // Rows fetched under another status or involvement filter are not members now.
      this.remote = null;
    }
    const pending = this.pendingRemote;
    if (
      (pending && pending.search === search && pending.scopeKey === key) ||
      (!pending && this.remote?.search === search && this.remote.scopeKey === key)
    ) {
      return;
    }
    this.cancelRemoteSearch();
    const request = this.remoteRequest;
    const scope = this.scope;
    this.pendingRemote = { search, scopeKey: key };
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      void this.runRemoteSearch(request, search, scope);
    }, SESSION_SEARCH_REMOTE_DELAY_MS);
  }

  private async runRemoteSearch(request: number, search: string, scope: SidebarSessionSearchScope) {
    const context = this.context;
    const sessions = context?.sessions;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    const isCurrent = () =>
      request === this.remoteRequest &&
      this.context?.sessions === sessions &&
      gateway?.snapshot.phase === "connected" &&
      gateway.snapshot.client === client;
    if (!sessions || !client || !isCurrent()) {
      if (request === this.remoteRequest) {
        this.pendingRemote = null;
      }
      return;
    }
    let rows: readonly GatewaySessionRow[] = [];
    try {
      const result = await sessions.list({
        search,
        limit: SESSION_SEARCH_REMOTE_LIMIT,
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        archivedFilter: scope.statusFilter,
        ...(scope.involvingMe ? { involvingMe: true } : {}),
      });
      rows = result?.sessions ?? [];
    } catch {
      // Metadata search is best-effort; the loaded window still answers.
    }
    if (!isCurrent()) {
      return;
    }
    this.pendingRemote = null;
    this.remote = { client, search, scopeKey: scopeKey(scope), rows };
  }

  private visibleGatewayRows(rows: readonly GatewaySessionRow[]): GatewaySessionRow[] {
    const context = this.context;
    const { scope } = this;
    const visible = filterVisibleSessionRows(rows, {
      agentId: "",
      defaultAgentId: resolveUiDefaultAgentId({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      }),
      filterByAgent: false,
      showCron: scope.showCron,
      showSystem: scope.showSystem,
      archivedFilter: scope.statusFilter,
    });
    return scope.ownerId ? visible.filter((row) => row.owner?.actor.id === scope.ownerId) : visible;
  }

  private agentCards() {
    const context = this.context;
    return context
      ? agentRosterCards(context.agents.state.agentsList ?? undefined, [], (id) =>
          context.agentIdentity.get(id),
        )
      : [];
  }

  private rankResults(): SearchResults {
    const agents = this.agentCards().map((card) => ({ id: card.id, name: card.name }));
    const agentIds = new Set(agents.map((agent) => agent.id));
    const toSidebarSession = this.toSidebarSession;
    const seen = new Set<string>();
    const local: SidebarRecentSession[] = [];
    const remote: SidebarRecentSession[] = [];
    const admit = (row: SidebarRecentSession, target: SidebarRecentSession[]) => {
      if (!seen.has(row.key)) {
        seen.add(row.key);
        target.push(row);
      }
    };
    const admitGatewayRows = (
      rows: readonly GatewaySessionRow[],
      target: SidebarRecentSession[],
    ) => {
      if (!toSidebarSession) {
        return;
      }
      for (const row of this.visibleGatewayRows(rows)) {
        const session = toSidebarSession(row);
        if (session.agentId && agentIds.has(session.agentId)) {
          admit(session, target);
        }
      }
    };
    for (const row of this.rows) {
      admit(row, local);
    }
    const context = this.context;
    // The shared window is read without the involving-me filter, which only
    // the Gateway evaluates; the metadata search carries it instead.
    if (context && this.agentsMode === "chip" && !this.scope.involvingMe) {
      admitGatewayRows(rosterActivityStore(context).snapshot.result?.sessions ?? [], local);
    }
    if (this.remote && this.remote.client === context?.gateway.snapshot.client) {
      admitGatewayRows(this.remote.rows, remote);
    }
    const groups = rankSessionSearch<SearchCandidate>({
      tokens: tokenizeSearchQuery(this.query),
      agents,
      sessions: [...local, ...remote].map((row) => ({
        key: row.key,
        agentId: row.agentId ?? "",
        title: row.label,
        group: row.category,
        pinned: row.pinned,
        updatedAt: row.updatedAt,
        row,
      })),
      remoteKeys: new Set(remote.map((row) => row.key)),
    });
    return this.agentsMode === "roster" && this.layout === "flat"
      ? { flat: true, hits: flattenSessionSearch(groups) }
      : { flat: false, groups };
  }

  private open(option: SearchOption) {
    if (option.kind === "agent") {
      this.host.openMainSession(option.agentId);
    } else {
      this.host.selectSession(option.key);
    }
  }

  private moveCursor(delta: number) {
    const count = this.options.length;
    if (count > 0) {
      this.cursor = (((this.cursor + delta) % count) + count) % count;
      this.scrollCursorIntoView = true;
    }
  }

  private readonly handleInputKeydown = (event: KeyboardEvent) => {
    if (event.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (this.options.length > 0) {
          event.preventDefault();
          this.moveCursor(event.key === "ArrowDown" ? 1 : -1);
        }
        break;
      case "Enter": {
        const option = this.options[this.cursor];
        if (option) {
          event.preventDefault();
          this.open(option);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        if (this.query) {
          this.onQueryChange("");
        } else {
          (event.currentTarget as HTMLInputElement).blur();
        }
        break;
      default:
        break;
    }
  };

  // Capture phase on window runs before the chat's type-to-compose handler,
  // which would otherwise move the keystroke into the composer.
  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (
      event.key !== "/" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing ||
      event.defaultPrevented ||
      !this.active ||
      document.openClawModalLayers?.size ||
      document.querySelector("dialog[open], [aria-modal='true']") ||
      event
        .composedPath()
        .some((target) => target instanceof Element && target.matches(EDITABLE_TARGET_SELECTOR))
    ) {
      return;
    }
    const input = this.querySelector<HTMLInputElement>(".sidebar-session-search__input");
    if (!input || (typeof input.checkVisibility === "function" && !input.checkVisibility())) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    input.focus();
    input.select();
  };

  private renderLayoutToggle() {
    if (this.agentsMode !== "roster") {
      return nothing;
    }
    const layouts = [
      { layout: "grouped", label: t("chat.sidebar.search.layoutGrouped"), icon: icons.layoutList },
      { layout: "flat", label: t("chat.sidebar.search.layoutFlat"), icon: icons.list },
    ] as const;
    return html`<div
      class="sidebar-session-search__layout"
      role="radiogroup"
      aria-label=${t("chat.sidebar.search.layout")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        event.preventDefault();
        const layout = event.key === "ArrowLeft" ? "grouped" : "flat";
        this.host.setRosterLayout(layout);
        void this.updateComplete.then(() =>
          this.querySelector<HTMLElement>(`[data-roster-layout="${layout}"]`)?.focus(),
        );
      }}
    >
      ${layouts.map(
        ({ layout, label, icon }) =>
          html`<button
            type="button"
            class="sidebar-session-search__layout-button"
            role="radio"
            data-roster-layout=${layout}
            aria-checked=${String(this.layout === layout)}
            aria-label=${label}
            title=${label}
            tabindex=${this.layout === layout ? "0" : "-1"}
            @click=${() => this.host.setRosterLayout(layout)}
          >
            ${icon}
          </button>`,
      )}
    </div>`;
  }

  private renderResults(results: SearchResults) {
    const cardsById = new Map(
      this.agentCards().map((card) => [
        card.id,
        { ...card, avatar: card.avatar ? this.avatars.resolve(card.avatar) : null },
      ]),
    );
    const avatar = (agentId: string) => {
      const card = cardsById.get(agentId);
      return html`<span class="sidebar-session-search__avatar" aria-hidden="true"
        >${card ? renderAgentIdentityAvatar(card) : nothing}</span
      >`;
    };
    const runState = (row: SidebarRecentSession) =>
      row.hasActiveRun
        ? html`<span
            class="session-run-spinner"
            role="img"
            aria-label=${t("sessionsView.activeRun")}
          ></span>`
        : row.unread
          ? html`<span
              class="session-unread-dot"
              role="img"
              aria-label=${t("sessionsView.unread")}
            ></span>`
          : nothing;
    let index = 0;
    const option = (params: {
      option: SearchOption;
      className: string;
      remote?: boolean;
      active?: boolean;
      content: unknown;
    }) => {
      const current = index++;
      const selected = current === this.cursor;
      const classes = [
        "sidebar-session-search__option",
        params.className,
        params.remote ? "sidebar-session-search__option--remote" : "",
        params.active ? "sidebar-session-search__option--active" : "",
        selected ? "sidebar-session-search__option--cursor" : "",
      ];
      return html`<div
        id=${`${OPTION_ID_PREFIX}${current}`}
        class=${classes.filter(Boolean).join(" ")}
        role="option"
        aria-selected=${String(selected)}
        data-session-search-key=${params.option.kind === "session" ? params.option.key : nothing}
        data-session-search-agent=${
          params.option.kind === "agent" ? params.option.agentId : nothing
        }
        @click=${() => this.open(params.option)}
      >
        ${params.content}
      </div>`;
    };
    const title = (text: string, positions: readonly number[] | undefined) =>
      html`<span class="sidebar-session-search__title"
        >${renderHighlighted(text, positions)}</span
      >`;
    const query = this.query.trim();
    const body = results.flat
      ? results.hits.length === 0
        ? html`<p class="sidebar-session-search__empty">
            ${t("chat.sidebar.search.noSessions", { query })}
          </p>`
        : results.hits.map((hit) => {
            const { row } = hit.session;
            const positions = hit.match?.positions;
            const preview = this.showPreview ? row.lastMessagePreview : undefined;
            return option({
              option: { kind: "session", key: row.key },
              className: "sidebar-session-search__session sidebar-session-search__session--flat",
              remote: hit.remote,
              active: row.visuallyActive,
              content: html`${avatar(hit.agentId)}
                <span class="sidebar-session-search__copy">
                  ${title(row.label, positions?.[0])}
                  <span class="sidebar-session-search__meta"
                    >${renderHighlighted(hit.agentName, positions?.[1])}${
                      row.category
                        ? html` · ${renderHighlighted(row.category, positions?.[2])}`
                        : nothing
                    }${preview ? ` · ${preview}` : nothing}</span
                  >
                </span>
                ${runState(row)}`,
            });
          })
      : results.groups.length === 0
        ? html`<p class="sidebar-session-search__empty">
            ${t("chat.sidebar.search.noResults", { query })}
          </p>`
        : results.groups.map(
            (group) =>
              html`<div class="sidebar-session-search__group" role="group" aria-label=${group.name}>
                ${option({
                  option: { kind: "agent", agentId: group.agentId },
                  className: "sidebar-session-search__agent",
                  content: html`${avatar(group.agentId)}
                    <span class="sidebar-session-search__copy"
                      >${title(group.name, group.highlight)}</span
                    >`,
                })}
                ${group.sessions.map((hit) => {
                  const { row } = hit.session;
                  return option({
                    option: { kind: "session", key: row.key },
                    className: "sidebar-session-search__session",
                    remote: hit.remote,
                    active: row.visuallyActive,
                    content: html`<span class="sidebar-session-search__copy">
                        ${title(row.label, hit.match?.positions[0])}
                        ${
                          row.category
                            ? html`<span class="sidebar-session-search__meta"
                                >${renderHighlighted(row.category, hit.match?.positions[2])}</span
                              >`
                            : nothing
                        }
                      </span>
                      ${runState(row)}`,
                  });
                })}
              </div>`,
          );
    return html`<div
        id=${RESULTS_ID}
        class="sidebar-session-search__results ${
          results.flat ? "sidebar-session-search__results--flat" : ""
        }"
        role="listbox"
        aria-label=${t("chat.sidebar.search.results")}
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
      >
        ${body}
      </div>
      ${
        this.remoteCount > 0
          ? html`<p class="sidebar-session-search__footer">
              ${t("chat.sidebar.search.olderSessions", { count: String(this.remoteCount) })}
            </p>`
          : nothing
      }`;
  }

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const results = this.results;
      const activeOption = results !== null && this.options.length > 0;
      return html`<div class="sidebar-session-search" role="search">
        <div class="sidebar-session-search__bar">
          <div class="sidebar-session-search__box">
            <span class="sidebar-session-search__icon" aria-hidden="true">${icons.search}</span>
            <input
              class="sidebar-session-search__input"
              type="text"
              role="combobox"
              autocomplete="off"
              spellcheck="false"
              aria-label=${t("chat.sidebar.search.label")}
              aria-autocomplete="list"
              aria-expanded=${String(results !== null)}
              aria-controls=${results ? RESULTS_ID : nothing}
              aria-activedescendant=${activeOption ? `${OPTION_ID_PREFIX}${this.cursor}` : nothing}
              placeholder=${t("common.search")}
              .value=${this.query}
              @input=${(event: Event) =>
                this.onQueryChange((event.currentTarget as HTMLInputElement).value)}
              @keydown=${this.handleInputKeydown}
            />
            ${
              this.query
                ? html`<button
                    type="button"
                    class="sidebar-session-search__clear"
                    aria-label=${t("chat.sidebar.search.clear")}
                    @click=${() => {
                      this.onQueryChange("");
                      this.querySelector<HTMLInputElement>(
                        ".sidebar-session-search__input",
                      )?.focus();
                    }}
                  >
                    ${icons.x}
                  </button>`
                : nothing
            }
          </div>
          ${this.renderLayoutToggle()}
        </div>
        ${results ? this.renderResults(results) : nothing}
      </div>`;
    });
  }
}

if (!customElements.get("openclaw-sidebar-session-search")) {
  customElements.define("openclaw-sidebar-session-search", SidebarSessionSearch);
}
