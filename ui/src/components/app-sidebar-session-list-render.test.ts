import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import { renderSessionSection } from "./app-sidebar-session-list-render.ts";

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
});

const host = {
  collapsedSessionSections: new Set<string>(),
  sessionOwnerFilterActive: false,
  sessionOwnerFilterId: null,
  sessionOwnershipVisible: false,
  sessionOwnerOptions: [],
  readNewSessionAccess: () => ({ allowed: true }),
  readSessionMutationAccess: () => ({ allowed: true }),
  sessionOrganizer: {
    draggingSidebarSection: null,
    draggingSessionKey: null,
    sessionDropTarget: null,
    sidebarSectionDropTarget: null,
  },
};

function section(id: string) {
  return {
    id,
    label: id,
    rows: [],
    totalRowCount: 0,
    visibleRowCount: 0,
    visibleLimit: 10,
    collapsedVisibleRowCount: 0,
    renderHeader: false,
  };
}

it("renders nothing for an agent section without sessions", () => {
  render(
    renderSessionSection({
      host: host as never,
      section: section("agent:main") as never,
      personHeaders: undefined,
    }),
    container,
  );
  expect(container.querySelector(".sidebar-recent-sessions__group")).toBeNull();
});
