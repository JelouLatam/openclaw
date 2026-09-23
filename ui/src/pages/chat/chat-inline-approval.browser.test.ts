import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import baseStyles from "../../styles/base.css?inline";
import layoutStyles from "../../styles/chat/layout.css?inline";

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
  container.remove();
});

it("keeps an inline approval above transcript rows that underlap the composer stack", () => {
  document.body.append(container);
  render(
    html`
      <style>
        ${baseStyles}${layoutStyles}
      </style>
      <div class="chat-main__conversation" style="display: flex; flex-direction: column">
        <div class="chat-virtual-sizer" style="height: 120px; margin-bottom: -60px">
          <div class="chat-virtual-block" style="height: 120px">Transcript row</div>
        </div>
        <div class="chat-inline-approval" style="height: 80px">Approve this command?</div>
      </div>
    `,
    container,
  );
  const approval = container.querySelector<HTMLElement>(".chat-inline-approval")!;
  const bounds = approval.getBoundingClientRect();
  const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 10);
  expect(hit).toBe(approval);
});
