import { expect, type Page } from "@playwright/test";

/**
 * Injects one synthetic "live" MQTT telemetry message into the browser's
 * real `/api/mqtt/stream` EventSource connection, without touching the
 * broker or any shared database state. Must be called before `signIn` (i.e.
 * before the first navigation) so the patched `EventSource` constructor is
 * installed before the app's own `new EventSource(...)` call runs.
 *
 * This exercises the exact client-side code path a genuine broker delivery
 * would (`ingestPayload` -> `extractModbusRows` -> `setModbusRows`, tagged
 * `provenance: 'live'`), which lets a test assert that a distinctive live
 * value is visible on live-preferring screens but never leaks into the
 * Dashboard Overview's saved-only evidence pipeline.
 */
export async function injectLiveTelemetry(page: Page, parameter: Record<string, unknown>, delayMs = 1_500) {
  await page.addInitScript(
    ({ parameter, delayMs }) => {
      const NativeEventSource = window.EventSource;
      class InjectingEventSource extends NativeEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          if (String(url).includes("/api/mqtt/stream")) {
            setTimeout(() => {
              this.dispatchEvent(new MessageEvent("message", {
                data: JSON.stringify({
                  topic: "e2e-injected-live-telemetry",
                  payload: JSON.stringify([parameter]),
                  receivedAt: new Date().toISOString(),
                }),
              }));
            }, delayMs);
          }
        }
      }
      // @ts-expect-error -- intentionally replacing the global constructor for the test.
      window.EventSource = InjectingEventSource;
    },
    { parameter, delayMs },
  );
}

/**
 * Shared sign-in helper for the SCADA e2e suite. Logs in as the qa.operator
 * fixture provisioned by global-setup.ts (see
 * lib/db/src/fixtures/scada-qa-operator.ts).
 */
export async function signIn(page: Page) {
  const baseUrl = process.env.SCADA_E2E_BASE_URL;
  if (!baseUrl) throw new Error("SCADA_E2E_BASE_URL is required for the SCADA e2e suite.");
  const username = process.env.SCADA_E2E_USERNAME;
  const password = process.env.SCADA_E2E_PASSWORD;
  if (!username || !password) throw new Error("global-setup.ts must run before this spec (missing SCADA_E2E_USERNAME/PASSWORD).");
  await page.goto(baseUrl);
  await page.addStyleTag({ content: "#replit-dev-banner { display: none !important; }" });
  await expect(page.getByRole("heading", { name: "Sign in to SCADA" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in to SCADA" }).click();
}
