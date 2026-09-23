import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { SessionListOptions } from "../lib/sessions/index.ts";
import "../test-helpers/load-styles.ts";

const LAYOUT_KEY = "openclaw:sidebar:sessions:roster-layout";
const NOW = Date.now();

function listResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: NOW,
    path: "",
    count: sessions.length,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions,
  };
}

async function mountSearch(options: { roster?: boolean; layout?: "flat" | "grouped" } = {}) {
  // The roster renderer is an idle import; load it up front so waits measure behavior.
  await Promise.all([import("./app-sidebar.ts"), import("./sidebar-agent-roster.ts")]);
  const { mountRoster, roster, session } =
    await import("../test-helpers/app-sidebar-cases/roster.test-support.ts");
  if (options.layout) {
    localStorage.setItem(LAYOUT_KEY, options.layout);
  }
  const row = (agentId: string, key: string, updatedAt: number, extra = {}) =>
    session(agentId, updatedAt, { key: `agent:${agentId}:${key}`, isMain: false, ...extra });
  const rows = [
    session("main", NOW - 10_000),
    row("recent", "release", NOW - 1_000, { label: "Release notes" }),
    row("working", "deploy", NOW - 2_000, { label: "Deploy checklist", hasActiveRun: true }),
    row("main", "planning", NOW - 3_000, { label: "Quarterly planning", category: "Roadmap" }),
    row("working", "pinned", NOW - 50_000, { label: "Pinned notes", pinned: true, pinnedAt: NOW }),
    row("recent", "archived", NOW, { label: "Release archive", archived: true }),
  ];
  const mounted = await mountRoster(roster, rows);
  const onNavigate = vi.fn();
  mounted.sidebar.onNavigate = onNavigate;
  if (options.roster) {
    mounted.sidebar.sidebarAgentsMode = "roster";
  }
  await mounted.sidebar.updateComplete;
  const input = () =>
    mounted.sidebar.querySelector<HTMLInputElement>(".sidebar-session-search__input")!;
  await vi.waitFor(() => expect(input()).not.toBeNull());
  return { ...mounted, onNavigate, input };
}

function sessionKeys(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>(".sidebar-recent-session")].map(
    (row) => row.dataset.sessionKey,
  );
}

function optionIds(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>(".sidebar-session-search__option")].map(
    (option) => option.dataset.sessionSearchKey ?? `agent:${option.dataset.sessionSearchAgent}`,
  );
}

async function typeQuery(input: HTMLInputElement, query: string) {
  const { userEvent } = await import("vitest/browser");
  await userEvent.fill(input, query);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("openclaw:sidebar:sessions:sort-mode", "updated");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe.runIf("__vitest_browser__" in globalThis)("sidebar session search", () => {
  it("shows all agents as one flat list in the sidebar's own order", async () => {
    const { sidebar } = await mountSearch({ roster: true });

    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual([
        "agent:working:pinned",
        "agent:recent:release",
        "agent:working:deploy",
        "agent:main:planning",
        "agent:main:main",
      ]),
    );
    expect(sidebar.querySelector("[data-agent-group]")).toBeNull();
    expect(
      sidebar
        .querySelector('[data-session-key="agent:recent:release"] .sidebar-recent-session__agent')
        ?.getAttribute("title"),
    ).toBe("Scout");
    expect(sidebar.querySelector('[data-roster-layout="flat"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("switches to the grouped roster and remembers the choice", async () => {
    const first = await mountSearch({ roster: true });
    await vi.waitFor(() => expect(sessionKeys(first.sidebar)).toHaveLength(5));

    first.sidebar.querySelector<HTMLButtonElement>('[data-roster-layout="grouped"]')?.click();
    await vi.waitFor(() =>
      expect(first.sidebar.querySelector('[data-agent-group="working"]')).not.toBeNull(),
    );
    expect(localStorage.getItem(LAYOUT_KEY)).toBe("grouped");
    expect(sessionKeys(first.sidebar.querySelector('[data-agent-group="working"]')!)).toEqual([
      "agent:working:pinned",
      "agent:working:deploy",
    ]);

    document.body.replaceChildren();
    const second = await mountSearch({ roster: true });
    await vi.waitFor(() =>
      expect(second.sidebar.querySelector('[data-agent-group="main"]')).not.toBeNull(),
    );
    const flat = second.sidebar.querySelector<HTMLButtonElement>('[data-roster-layout="flat"]')!;
    expect(flat.getAttribute("aria-checked")).toBe("false");
    flat.click();
    await vi.waitFor(() => expect(second.sidebar.querySelector("[data-agent-group]")).toBeNull());
    expect(localStorage.getItem(LAYOUT_KEY)).toBe("flat");
  });

  it("filters the flat list with fuzzy, accent-free matches across agents", async () => {
    const { sidebar, input } = await mountSearch({ roster: true });
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toHaveLength(5));

    await typeQuery(input(), "RELEASE");
    await vi.waitFor(() => expect(optionIds(sidebar)).toEqual(["agent:recent:release"]));
    expect(sidebar.querySelector<HTMLElement>(".sidebar-session-list-body")?.hidden).toBe(true);
    expect(sidebar.querySelector(".sidebar-session-search__mark")?.textContent).toBe("Release");

    await typeQuery(input(), "forge");
    await vi.waitFor(() =>
      expect(optionIds(sidebar)).toEqual(["agent:working:pinned", "agent:working:deploy"]),
    );
    await typeQuery(input(), "forge dplo");
    await vi.waitFor(() => expect(optionIds(sidebar)).toEqual(["agent:working:deploy"]));
    await typeQuery(input(), "roadmap quarterly");
    await vi.waitFor(() => expect(optionIds(sidebar)).toEqual(["agent:main:planning"]));

    await typeQuery(input(), "nothing like this");
    await vi.waitFor(() =>
      expect(sidebar.querySelector(".sidebar-session-search__empty")?.textContent?.trim()).toBe(
        'No sessions match "nothing like this"',
      ),
    );
  });

  it("ranks grouped and one-agent results by agent, listing every session of a matched agent", async () => {
    const grouped = await mountSearch({ roster: true, layout: "grouped" });
    await vi.waitFor(() =>
      expect(grouped.sidebar.querySelector('[data-agent-group="main"]')).not.toBeNull(),
    );
    await typeQuery(grouped.input(), "harbor");
    await vi.waitFor(() =>
      expect(optionIds(grouped.sidebar)).toEqual([
        "agent:main",
        "agent:main:planning",
        "agent:main:main",
      ]),
    );

    document.body.replaceChildren();
    const oneAgent = await mountSearch();
    expect(oneAgent.sidebar.querySelector(".sidebar-session-search__layout")).toBeNull();
    await typeQuery(oneAgent.input(), "release");
    // The selected agent's list does not hold Scout's rows; the shared window does.
    await vi.waitFor(() =>
      expect(optionIds(oneAgent.sidebar)).toEqual(["agent:recent", "agent:recent:release"]),
    );
    expect(oneAgent.sidebar.querySelector(".sidebar-session-search__option--remote")).toBeNull();
  });

  it("appends Gateway metadata matches the loaded window lacks and drops superseded answers", async () => {
    const { sidebar, input, sessions } = await mountSearch({ roster: true });
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toHaveLength(5));
    const pending = new Map<string, (rows: GatewaySessionRow[]) => void>();
    sessions.list.mockImplementation((options?: SessionListOptions) =>
      options?.search
        ? new Promise<SessionsListResult | null>((resolve) => {
            pending.set(options.search!, (rows) => resolve(listResult(rows)));
          })
        : Promise.resolve(null),
    );
    const older = (key: string, label: string) =>
      ({
        key: `agent:recent:${key}`,
        agentId: "recent",
        kind: "direct",
        label,
        updatedAt: NOW - 400 * 86_400_000,
      }) satisfies GatewaySessionRow;

    await typeQuery(input(), "migration");
    await vi.waitFor(() => expect(pending.has("migration")).toBe(true));
    expect(sessions.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "migration", limit: 40, archivedFilter: "active" }),
    );
    await typeQuery(input(), "rollout");
    await vi.waitFor(() => expect(pending.has("rollout")).toBe(true));
    pending.get("migration")?.([older("migration", "Migration plan")]);
    pending.get("rollout")?.([
      older("rollout", "Rollout review"),
      older("rollout-archived", "Rollout archive"),
    ]);
    await vi.waitFor(() =>
      expect(optionIds(sidebar)).toEqual(["agent:recent:rollout", "agent:recent:rollout-archived"]),
    );
    expect(sidebar.querySelectorAll(".sidebar-session-search__option--remote")).toHaveLength(2);
    expect(sidebar.querySelector(".sidebar-session-search__footer")?.textContent?.trim()).toBe(
      "+2 from older sessions",
    );
    expect(sidebar.querySelector('[data-session-search-key="agent:recent:migration"]')).toBeNull();

    // Loaded rows answer first; the Gateway only adds what the window lacked.
    await typeQuery(input(), "re");
    await vi.waitFor(() => expect(pending.has("re")).toBe(true));
    pending.get("re")?.([older("release", "Release notes"), older("rewind", "Rewind notes")]);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-session-search-key="agent:recent:rewind"]')?.className,
      ).toContain("--remote"),
    );
    expect(
      sidebar.querySelector('[data-session-search-key="agent:recent:release"]')?.className,
    ).not.toContain("--remote");
  });

  it("focuses with slash, moves with arrows, opens with Enter, and clears then blurs with Escape", async () => {
    const { userEvent } = await import("vitest/browser");
    const { sidebar, input, onNavigate } = await mountSearch({ roster: true, layout: "grouped" });
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-agent-group="main"]')).not.toBeNull(),
    );

    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    await userEvent.keyboard("/");
    expect(editor.value).toBe("/");
    expect(document.activeElement).toBe(editor);

    editor.blur();
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("");

    await userEvent.keyboard("release");
    await vi.waitFor(() =>
      expect(optionIds(sidebar)).toEqual(["agent:recent", "agent:recent:release"]),
    );
    const activeOption = () =>
      sidebar.querySelector(`#${input().getAttribute("aria-activedescendant")}`);
    expect(activeOption()?.getAttribute("data-session-search-agent")).toBe("recent");
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(activeOption()?.getAttribute("data-session-search-key")).toBe("agent:recent:release"),
    );
    expect(activeOption()?.classList.contains("sidebar-session-search__option--cursor")).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(activeOption()?.getAttribute("data-session-search-agent")).toBe("recent"),
    );
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: expect.stringContaining("/chat/recent/release") }),
      ),
    );

    onNavigate.mockClear();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: expect.stringContaining("/chat/recent") }),
      ),
    );

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(input().value).toBe(""));
    expect(sidebar.querySelector(".sidebar-session-search__results")).toBeNull();
    expect(sidebar.querySelector<HTMLElement>(".sidebar-session-list-body")?.hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(input());
  });
});
