import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

const agents: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor" },
    { id: "union-bank", name: "Banco Unión" },
    { id: "ops-desk", name: "Operations" },
    { id: "coast-bank", name: "Banco Costa" },
    ...Array.from({ length: 40 }, (_, index) => ({ id: `fleet-${index}`, name: `Fleet ${index}` })),
  ],
};

describe.runIf("__vitest_browser__" in globalThis)("sidebar new-session agent search", () => {
  it("filters a capped agent menu while keys stay in the search field", async () => {
    await import("./app-sidebar.ts");
    await import("./sidebar-agent-roster.ts");
    const { mountRoster } =
      await import("../test-helpers/app-sidebar-cases/roster.test-support.ts");
    const { focusChatComposerFromPrintableKeydown } =
      await import("../pages/chat/chat-pane-shared.ts");
    const { userEvent } = await import("vitest/browser");

    const chat = document.createElement("div");
    chat.innerHTML = `<div class="agent-chat__composer-combobox"><textarea></textarea></div>`;
    document.body.append(chat);
    const composer = chat.querySelector("textarea")!;
    const typeAnywhere = (event: KeyboardEvent) =>
      focusChatComposerFromPrintableKeydown(chat, event);
    document.addEventListener("keydown", typeAnywhere, true);

    try {
      const { sidebar } = await mountRoster(agents, []);
      const onOpen = vi.fn();
      sidebar.onOpenNewSession = onOpen;
      sidebar.sidebarAgentsMode = "roster";
      const dropdown = await vi.waitFor(() => {
        const element = sidebar.querySelector<HTMLElement & { open: boolean }>(
          ".sidebar-new-session-menu",
        );
        expect(element?.querySelectorAll("wa-dropdown-item")).toHaveLength(44);
        return element!;
      });
      const trigger = dropdown.querySelector<HTMLButtonElement>('[slot="trigger"]')!;
      const itemIds = () =>
        [...dropdown.querySelectorAll("wa-dropdown-item:not([hidden])")].map((item) =>
          item.getAttribute("value"),
        );
      const empty = () => dropdown.querySelector(".sidebar-new-session-menu__empty");

      await userEvent.click(trigger);
      const input = dropdown.querySelector<HTMLInputElement>(
        ".sidebar-new-session-menu__search-input",
      );
      expect(input).not.toBeNull();
      await expect.poll(() => document.activeElement).toBe(input);

      const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
      const menuStyle = getComputedStyle(menu);
      expect(menuStyle.width).toBe(`${Math.min(280, window.innerWidth - 24)}px`);
      expect(menuStyle.maxHeight).toBe(`${Math.min(440, window.innerHeight - 112)}px`);
      expect(menuStyle.overscrollBehaviorY).toBe("contain");
      expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
      menu.scrollTop = menu.scrollHeight;
      const search = dropdown.querySelector<HTMLElement>(".sidebar-new-session-menu__search")!;
      expect(
        search.getBoundingClientRect().top - menu.getBoundingClientRect().top,
      ).toBeLessThanOrEqual(8);
      menu.scrollTop = 0;
      await userEvent.click(input!);
      expect(dropdown.open).toBe(true);

      // "f" is also Web Awesome typeahead for "Fleet 0".
      await userEvent.keyboard("fleet 1");
      expect(document.activeElement).toBe(input);
      expect(input?.value).toBe("fleet 1");
      expect(composer.value).toBe("");
      await expect
        .poll(itemIds)
        .toEqual(["fleet-1", ...Array.from({ length: 10 }, (_, index) => `fleet-${10 + index}`)]);

      await userEvent.clear(input!);
      await userEvent.type(input!, "UNION");
      await expect.poll(itemIds).toEqual(["union-bank"]);
      await userEvent.clear(input!);
      await userEvent.type(input!, "cöstá");
      await expect.poll(itemIds).toEqual(["coast-bank"]);
      await userEvent.clear(input!);
      await userEvent.type(input!, "desk");
      await expect.poll(itemIds).toEqual(["ops-desk"]);

      await userEvent.clear(input!);
      await userEvent.type(input!, "nobody");
      await expect.poll(itemIds).toEqual([]);
      expect(empty()?.textContent).toBe("No matching agents");
      expect(document.activeElement).toBe(input);
      expect(composer.value).toBe("");

      await userEvent.clear(input!);
      await userEvent.type(input!, "banco");
      await expect.poll(itemIds).toEqual(["union-bank", "coast-bank"]);
      expect(empty()).toBeNull();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement?.getAttribute("value")).toBe("union-bank");
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement?.getAttribute("value")).toBe("coast-bank");
      await userEvent.keyboard("{Enter}");
      expect(onOpen).toHaveBeenCalledWith("coast-bank");
      await expect.poll(() => dropdown.open).toBe(false);

      await userEvent.click(trigger);
      await expect.poll(() => document.activeElement).toBe(input);
      expect(input?.value).toBe("");
      expect(itemIds()).toHaveLength(44);
      await userEvent.keyboard("   ");
      expect(itemIds()).toHaveLength(44);
      expect(empty()).toBeNull();
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => dropdown.open).toBe(false);
      await userEvent.click(trigger);
      await expect.poll(() => document.activeElement).toBe(input);
      await userEvent.keyboard("{Tab}");
      await expect.poll(() => dropdown.open).toBe(false);
    } finally {
      document.removeEventListener("keydown", typeAnywhere, true);
    }
  });
});
