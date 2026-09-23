import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";

type SearchableAgent = { id: string; name: string };
type DropdownItem = HTMLElement & { active: boolean };

function foldAgentSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

export function filterAgentsBySearch<T extends SearchableAgent>(
  agents: readonly T[],
  query: string,
): readonly T[] {
  const needle = foldAgentSearchText(query);
  if (!needle) {
    return agents;
  }
  return agents.filter(
    (agent) =>
      foldAgentSearchText(agent.name).includes(needle) ||
      foldAgentSearchText(agent.id).includes(needle),
  );
}

function handleAgentSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Tab" || event.key === "Escape") {
    return;
  }
  // wa-dropdown runs typeahead, Home/End and roving arrows from a document
  // keydown listener, which would pull the caret out of the field.
  event.stopPropagation();
  if (event.key !== "ArrowDown" || event.isComposing) {
    return;
  }
  const dropdown = (event.currentTarget as HTMLElement).closest("wa-dropdown");
  const items = [...(dropdown?.querySelectorAll<DropdownItem>(":scope > wa-dropdown-item") ?? [])];
  const first = items.find((item) => !item.hasAttribute("disabled"));
  if (!first) {
    return;
  }
  event.preventDefault();
  items.forEach((item) => (item.active = item === first));
  first.focus();
}

export function focusAgentSearch(root: ParentNode) {
  root
    .querySelector<HTMLInputElement>(".sidebar-new-session-menu__search-input")
    ?.focus({ preventScroll: true });
}

export function renderAgentSearch(params: {
  query: string;
  noMatches: boolean;
  onQueryChange: (query: string) => void;
}) {
  return html`<div class="sidebar-new-session-menu__search">
    <input
      class="sidebar-new-session-menu__search-input"
      type="search"
      autocomplete="off"
      spellcheck="false"
      aria-label=${t("agentsHome.searchAgentsLabel")}
      placeholder=${t("agentsHome.searchAgents")}
      .value=${params.query}
      @input=${(event: Event) =>
        params.onQueryChange((event.currentTarget as HTMLInputElement).value)}
      @keydown=${handleAgentSearchKeydown}
    />
    ${
      params.noMatches
        ? html`<p class="sidebar-new-session-menu__empty">${t("agentsHome.noMatchingAgents")}</p>`
        : nothing
    }
  </div>`;
}
