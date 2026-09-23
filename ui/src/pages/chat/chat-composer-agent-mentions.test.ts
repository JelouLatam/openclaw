/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayAgentRow } from "../../api/types.ts";
import { composerFixture, resetMentionComposerFixture } from "./chat-composer-mentions.test-support.ts";

afterEach(resetMentionComposerFixture);

describe.each(["chat", "new-session"] as const)("%s agent mentions", (kind) => {
  const roster: GatewayAgentRow[] = [
    { id: "main", name: "Main" },
    { id: "zeta", name: "Release Opsbot" },
    { id: "support", name: "Customer Ops" },
    { id: "ops", name: "Operations" },
    { id: "orbit", name: "Opsdesk" },
    { id: "legal", identity: { name: "Legal Álvarez" } },
  ];
  const options = (view: ReturnType<typeof composerFixture>) =>
    [...view.container.querySelectorAll('[role="option"]')].map((option) =>
      option.querySelector(".slash-menu-name")?.textContent?.trim(),
    );

  it("ranks the other agents above people and inserts plain @id text with the caret after it", async () => {
    const view = composerFixture(kind, "", [], undefined, roster);
    view.edit("Ask @ops about the launch", { data: "@ops", caret: 8 });

    expect(options(view)).toEqual(["Operations", "Opsdesk", "Release Opsbot", "Customer Ops"]);
    expect(view.container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      "Mention an agent or person",
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(options(view)).toEqual([
      "Operations",
      "Opsdesk",
      "Release Opsbot",
      "Customer Ops",
      "Alex",
      "Alex",
    ]);

    view.key("ArrowDown");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    await Promise.resolve();

    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({ draft: "Ask @orbit  about the launch", mentions: [] });
    expect(view.textarea.value).toBe("Ask @orbit  about the launch");
    expect(view.textarea.selectionStart).toBe("Ask @orbit ".length);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Will notify");
  });

  it("matches names without case or accents and never offers the current agent", () => {
    const view = composerFixture(kind, "", [], undefined, roster);
    view.edit("@ALVAREZ", { data: "@ALVAREZ" });
    expect(options(view)).toEqual(["Legal Álvarez"]);
    view.edit("@main", { data: "@main" });
    expect(options(view)).toEqual([]);
  });

  it("paints at most eight agents and counts the rest", () => {
    const fleet = Array.from({ length: 300 }, (_, index) => ({ id: `agent-${index}` }));
    const view = composerFixture(kind, "", [], undefined, fleet);
    view.setUnsupported();
    view.edit("@", { data: "@" });
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(8);
    expect(view.container.querySelectorAll(".chat-author-avatar")).toHaveLength(8);
    expect(view.container.textContent).toContain("292 more · keep typing");
    view.edit("@agent-29", { data: "9" });
    expect(options(view)).toHaveLength(8);
    expect(view.container.textContent).toContain("3 more · keep typing");
  });

  it("keeps person selection as a recipient mention below the agents", async () => {
    const view = composerFixture(kind, "", [], undefined, roster);
    view.edit("@", { data: "@" });
    await vi.advanceTimersByTimeAsync(150);
    expect(options(view)).toHaveLength(7);
    view.key("ArrowUp");
    expect(view.container.querySelector('[aria-selected="true"]')?.id).toMatch(
      /mention-option-1$/u,
    );
    view.key("ArrowUp");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.value()).toEqual({
      draft: "@Alex ",
      mentions: [{ profileId: "profile-alex-online", start: 0, end: 5 }],
    });
    expect(view.container.textContent).toContain("Will notify: @Alex");
  });

  it("offers agents without a people directory and leaves Enter to the composer when none match", () => {
    const view = composerFixture(kind, "", [], undefined, roster);
    view.setUnsupported();
    view.edit("@le", { data: "@le" });
    expect(view.container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      "Mention an agent",
    );
    expect(options(view)).toEqual(["Legal Álvarez", "Release Opsbot"]);
    view.key("ArrowDown");
    view.key("ArrowDown");
    view.key("Tab");
    expect(view.value()).toEqual({ draft: "@legal ", mentions: [] });

    view.edit("@legal @nobody", { data: "@nobody" });
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.send).toHaveBeenCalledOnce();
    expect(view.request).not.toHaveBeenCalled();
  });

  it("lets Escape dismiss the agents until another @ is typed", () => {
    const view = composerFixture(kind, "", [], undefined, roster);
    view.setUnsupported();
    view.edit("@o", { data: "@o" });
    view.key("Escape");
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    view.edit("@op", { data: "p" });
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    view.edit("@op @o", { data: "@o" });
    expect(options(view)).toEqual(["Operations", "Opsdesk", "Release Opsbot", "Customer Ops"]);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.abort).not.toHaveBeenCalled();
  });
});
