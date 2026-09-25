import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("centers short and wrapped names under active and inactive avatars", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Molty" },
          { id: "release", name: "Release reviewer" },
          { id: "research", name: "Research planning and documentation assistant" },
          { id: "scout", name: "Scout" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(4);
    const input = sidebar.querySelector<HTMLInputElement>(
      ".sidebar-agent-menu .sidebar-new-session-menu__search-input",
    );
    await expect.poll(() => document.activeElement).toBe(input);
    const { userEvent } = await import("vitest/browser");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tiles[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tiles[1]);
    await expect
      .poll(() => tiles.map((tile) => tile.getAttribute("aria-checked")))
      .toEqual(["true", "false", "false", "false"]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = tile.querySelector<HTMLElement>(".sidebar-agent-menu__agent-avatar")!;
      const label = tile.querySelector<HTMLElement>(".agent-select__option-label")!;
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      expect(
        Math.abs(labelBox.x + labelBox.width / 2 - (avatarBox.x + avatarBox.width / 2)),
        label.textContent ?? "agent name",
      ).toBeLessThanOrEqual(1);
    }
  });

  it("filters the agent grid from its search field and switches on Enter", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { userEvent } = await import("vitest/browser");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Atlas" },
          { id: "arca-trucks", name: "Arca Camiones" },
          { id: "arca-cold", name: "Arca PE Proyecto Frío" },
          { id: "union-bank", name: "Banco Unión" },
        ],
      },
    );
    const switchAgent = vi
      .spyOn(sidebar as unknown as { switchChipAgent: (id: string) => void }, "switchChipAgent")
      .mockImplementation(() => {});
    sidebar.connected = true;
    await sidebar.updateComplete;
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!;
    trigger.click();
    await sidebar.updateComplete;

    const menu = () => sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const input = () =>
      menu()?.querySelector<HTMLInputElement>(".sidebar-new-session-menu__search-input") ?? null;
    const visibleIds = () =>
      [...(menu()?.querySelectorAll(".sidebar-agent-menu__agent-switch:not([hidden])") ?? [])].map(
        (tile) => decodeURIComponent((tile.getAttribute("value") ?? "").slice("agent:".length)),
      );
    const empty = () => menu()?.querySelector(".sidebar-new-session-menu__empty") ?? null;
    await expect.poll(() => document.activeElement).toBe(input());
    expect(input()?.getAttribute("aria-label")).toBe("Search agents to switch to");
    expect(visibleIds()).toEqual(["main", "arca-trucks", "arca-cold", "union-bank"]);

    await userEvent.keyboard("arca");
    await expect.poll(visibleIds).toEqual(["arca-trucks", "arca-cold"]);
    expect(document.activeElement).toBe(input());

    await userEvent.clear(input()!);
    await userEvent.type(input()!, "nobody");
    await expect.poll(visibleIds).toEqual([]);
    expect(empty()?.textContent).toBe("No matching agents");

    await userEvent.clear(input()!);
    await userEvent.keyboard("{ArrowDown}");
    const tiles = menu()!.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch");
    expect(document.activeElement).toBe(tiles[0]);
    await userEvent.keyboard("frio");
    expect(document.activeElement).toBe(input());
    await expect.poll(() => input()?.value).toBe("frio");
    await expect.poll(visibleIds).toEqual(["arca-cold"]);

    await userEvent.keyboard("{Enter}");
    expect(switchAgent).toHaveBeenCalledWith("arca-cold");
    await expect.poll(menu).toBeNull();

    trigger.click();
    await sidebar.updateComplete;
    await expect.poll(() => document.activeElement).toBe(input());
    expect(input()?.value).toBe("");
    expect(visibleIds()).toHaveLength(4);
  });
});
