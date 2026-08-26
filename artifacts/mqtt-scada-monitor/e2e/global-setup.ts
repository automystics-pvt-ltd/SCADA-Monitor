import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { provisionScadaQaOperatorFixture } from "@workspace/db/fixtures/scada-qa-operator";

/**
 * Provisions the shared, least-privilege QA fixture (see
 * lib/db/src/fixtures/scada-qa-operator.ts and
 * scripts/src/provision-scada-test-operator.ts) before the e2e suite runs,
 * and exposes the generated password to the test workers via an environment
 * variable (Playwright worker processes inherit the parent's `process.env`).
 *
 * The fixture is intentionally durable and is not torn down after the run --
 * it is a permanent, isolated, synthetic test site that never touches real
 * plant data, so future runs and manual QA sessions can reuse it.
 */
export default async function globalSetup() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run the SCADA e2e suite with NODE_ENV=production.");
  }
  const password = process.env.SCADA_TEST_OPERATOR_PASSWORD ?? crypto.randomBytes(18).toString("base64url");
  const result = await provisionScadaQaOperatorFixture(password);
  process.env.SCADA_E2E_USERNAME = result.username;
  process.env.SCADA_E2E_PASSWORD = result.password;
  await pool.end();
}
