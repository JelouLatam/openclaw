import { describe, expect, it } from "vitest";
import { filterControlUiSessionResponse } from "./control-ui-display-filter.ts";

const prefixes = ["agent:atlas:whatsapp:atlas:direct:"];
const dm = { key: "agent:atlas:whatsapp:atlas:direct:synthetic-peer", channel: "whatsapp" };
const group = { key: "agent:atlas:whatsapp:group:synthetic-group", channel: "whatsapp" };
const chat = { key: "agent:atlas:dashboard:synthetic-chat", channel: "webchat" };

describe("Control UI session display filter", () => {
  it("omits only matching DMs from non-admin session lists", () => {
    const response = { sessions: [dm, group, chat], count: 3, hasMore: false };
    expect(filterControlUiSessionResponse("sessions.list", response, prefixes, false)).toEqual({
      ...response,
      sessions: [group, chat],
      count: 2,
    });
    expect(filterControlUiSessionResponse("sessions.list", response, prefixes, true)).toBe(
      response,
    );
  });

  it("omits matching metadata and transcript search hits", () => {
    const response = {
      sessions: [dm, group, chat],
      results: [
        { sessionKey: dm.key, snippet: "synthetic private text" },
        { sessionKey: group.key, snippet: "synthetic group text" },
      ],
    };
    expect(filterControlUiSessionResponse("sessions.search", response, prefixes, false)).toEqual({
      sessions: [group, chat],
      results: [{ sessionKey: group.key, snippet: "synthetic group text" }],
    });
    expect(filterControlUiSessionResponse("sessions.search", response, prefixes, true)).toBe(
      response,
    );
  });

  it("leaves direct session requests and unconfigured Gateways alone", () => {
    const response = { sessions: [dm] };
    expect(filterControlUiSessionResponse("sessions.describe", response, prefixes, false)).toBe(
      response,
    );
    expect(filterControlUiSessionResponse("sessions.list", response, [], false)).toBe(response);
  });
});
