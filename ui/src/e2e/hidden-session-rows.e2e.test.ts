import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI hidden session rows" });
const dmKey = "agent:main:whatsapp:atlas:direct:synthetic-peer";
const visibleKey = "agent:main:dashboard:synthetic-work";
const prefix = "agent:main:whatsapp:atlas:direct:";

suite.define(() => {
  it.each([
    { name: "team", scopes: ["operator.read"], dmVisible: false },
    { name: "admin", scopes: ["operator.read", "operator.admin"], dmVisible: true },
  ])("shows the configured DM only to $name", async ({ name, scopes, dmVisible }) => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await page.route("**/chat", async (route) => {
          const response = await route.fetch();
          const html = await response.text();
          await route.fulfill({
            response,
            body: html.replace(
              /<html\b/i,
              `<html data-openclaw-hidden-session-prefixes-for-non-admins='${JSON.stringify([prefix])}'`,
            ),
          });
        });
        const now = Date.now();
        const gateway = await installMockGateway(page, {
          operatorScopes: scopes,
          sessions: [
            createControlUiSessionRow(dmKey, "Synthetic WhatsApp DM", now),
            createControlUiSessionRow(visibleKey, "Synthetic work", now - 1000),
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        await gateway.waitForRequest("sessions.list");
        const sidebar = page.locator("openclaw-app-sidebar");
        await expect
          .poll(() => sidebar.locator(`[data-session-key="${visibleKey}"]`).count())
          .toBe(1);
        await expect
          .poll(() => sidebar.locator(`[data-session-key="${dmKey}"]`).count())
          .toBe(dmVisible ? 1 : 0);
        await page.screenshot({ path: path.join(suite.artifactDir, `${name}-sidebar.png`) });
      },
    );
  });
});
