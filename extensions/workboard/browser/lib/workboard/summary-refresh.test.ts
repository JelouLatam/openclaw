import "../../test/host.setup.ts";
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { waitForFast } from "../../test/wait-for.ts";
import { workboardCardMatchesHealthKey } from "./derived.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  noteWorkboardCardsChanged,
} from "./live-refresh.ts";
import { loadWorkboard } from "./loading.ts";
import { getWorkboardState, stopWorkboardLiveRefresh } from "./runtime.ts";
import { findWorkboardSessionCard } from "./session-links.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

const summaryOf = (card: WorkboardCard, overrides: Partial<WorkboardCard["summary"]> = {}) => {
  const { notes: _notes, events: _events, ...rest } = card;
  return {
    ...rest,
    summary: {
      hasNotes: Boolean(card.notes),
      comments: 0,
      attempts: 0,
      failedAttempts: 0,
      proof: 0,
      workerLogs: 0,
      notifications: 0,
      events: 0,
      sessionKeys: [],
      ...overrides,
    },
  };
};

const listCalls = (client: ReturnType<typeof createWorkboardTestClient>) =>
  client.request.mock.calls.filter(([method]) => method === "workboard.cards.list");

const hosts: object[] = [];
const createHost = () => {
  const host = {};
  hosts.push(host);
  return host;
};

afterEach(() => {
  for (const host of hosts.splice(0)) {
    stopWorkboardLiveRefresh(host);
  }
});

describe("Workboard summary reads", () => {
  it("folds a burst of changes into one trailing list read", async () => {
    const host = createHost();
    const client = createWorkboardTestClient({
      "workboard.cards.list": { cards: [], statuses: ["todo"] },
    });
    configureWorkboardLiveRefresh({ host, client });

    for (let revision = 1; revision <= 5; revision += 1) {
      handleWorkboardChanged(host, { epoch: "epoch-a", revision });
    }
    await waitForFast(() => expect(listCalls(client)).toHaveLength(1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(listCalls(client)).toHaveLength(1);
  });

  it("rereads only the named cards and falls back to the list after a missed revision", async () => {
    const host = createHost();
    const first = createWorkboardCard({ id: "card-1", title: "First" });
    const second = createWorkboardCard({ id: "card-2", title: "Second", position: 2000 });
    const client = createWorkboardTestClient((method, params) => {
      if (method === "workboard.cards.list") {
        return { cards: [summaryOf(first), summaryOf(second)], statuses: ["todo"] };
      }
      const id = (params as { id: string }).id;
      return {
        card: summaryOf({ ...(id === first.id ? first : second), title: `${id} v2`, updatedAt: 2 }),
      };
    });
    configureWorkboardLiveRefresh({ host, client });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await waitForFast(() => expect(getWorkboardState(host).cards).toHaveLength(2));

    noteWorkboardCardsChanged(host, { epoch: "epoch-a", revision: 2, cardIds: ["card-1"] });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 });
    noteWorkboardCardsChanged(host, { epoch: "epoch-a", revision: 3, cardIds: ["card-2"] });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 3 });
    await waitForFast(() =>
      expect(getWorkboardState(host).cards.map((card) => card.title)).toEqual([
        "card-1 v2",
        "card-2 v2",
      ]),
    );
    expect(listCalls(client)).toHaveLength(1);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.get", {
      id: "card-1",
      view: "summary",
    });

    noteWorkboardCardsChanged(host, { epoch: "epoch-a", revision: 5, cardIds: ["card-1"] });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 5 });
    await waitForFast(() => expect(listCalls(client)).toHaveLength(2));
  });

  it("keeps the open card's full copy across a summary reload and rereads it", async () => {
    const host = createHost();
    const open = createWorkboardCard({ notes: "Full notes", updatedAt: 1 });
    const changed = { ...open, notes: "Newer notes", updatedAt: 2 };
    const client = createWorkboardTestClient({
      "workboard.cards.list": { cards: [summaryOf(changed)], statuses: ["todo"] },
      "workboard.cards.get": { card: changed },
    });
    const state = getWorkboardState(host);
    state.cards = [open];
    state.detailCardId = open.id;

    await loadWorkboard({ host, client, force: true });
    expect(state.cards[0]?.summary).toBeUndefined();
    await waitForFast(() => expect(state.cards[0]?.notes).toBe("Newer notes"));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.get", { id: open.id });
  });

  it("lists summaries, with archived cards on request, and full cards while searching", async () => {
    const host = createHost();
    const client = createWorkboardTestClient({
      "workboard.cards.list": { cards: [], statuses: ["todo"] },
    });
    const state = getWorkboardState(host);

    await loadWorkboard({ host, client, force: true });
    state.showArchived = true;
    await loadWorkboard({ host, client, force: true });
    state.query = "invoice";
    await loadWorkboard({ host, client, force: true });
    expect(listCalls(client).map(([, params]) => params)).toEqual([
      { view: "summary" },
      { view: "summary", includeArchived: true },
      {},
    ]);
  });

  it("derives badges, filters and session links from a summary card", () => {
    const card = summaryOf(createWorkboardCard({ status: "done" }), {
      proof: 1,
      sessionKeys: ["agent:main:attempt"],
    }) as WorkboardCard;

    expect(workboardCardMatchesHealthKey(card, "missingProof", [])).toBe(false);
    expect(findWorkboardSessionCard([card], "agent:main:attempt")?.id).toBe(card.id);
  });
});
