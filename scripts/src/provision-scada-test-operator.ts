/**
 * Provisions (or repairs) a durable, low-privilege SCADA test operator so the
 * testing subagent -- or the committed Playwright suite in
 * artifacts/mqtt-scada-monitor/e2e -- can log in to authenticated SCADA
 * screens end-to-end.
 *
 * The actual fixture logic (fixture org/site, least-privilege access grant,
 * synthetic saved-parameter evidence) lives in
 * lib/db/src/fixtures/scada-qa-operator.ts, shared with the e2e suite so both
 * stay in sync. See that file for the safety model (least-privilege role,
 * dedicated fixture site, no committed password, stale-access revocation).
 *
 * This CLI additionally:
 *  - Refuses to run when NODE_ENV=production.
 *  - Never contains a literal password: provide SCADA_TEST_OPERATOR_PASSWORD
 *    yourself (recommended: as a Replit Secret) or omit it to get a freshly
 *    generated random password printed once to this command's output.
 *
 * Safe to re-run: it upserts the user, fixture org/site, access grants, and
 * fixture snapshot, so it never creates duplicates and always restores the
 * intended state.
 *
 * Usage: pnpm --filter @workspace/scripts run provision-scada-test-operator
 */
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { provisionScadaQaOperatorFixture } from "@workspace/db/fixtures/scada-qa-operator";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to provision the SCADA test operator with NODE_ENV=production. "
      + "This fixture is for development/test databases only.",
    );
  }

  const providedPassword = process.env.SCADA_TEST_OPERATOR_PASSWORD;
  if (providedPassword && providedPassword.length < 12) {
    throw new Error("SCADA_TEST_OPERATOR_PASSWORD must be at least 12 characters.");
  }
  const password = providedPassword ?? crypto.randomBytes(18).toString("base64url");

  const result = await provisionScadaQaOperatorFixture(password);

  console.log("SCADA test operator provisioned:");
  console.log(`  Username: ${result.username}`);
  console.log(`  Password: ${result.password}${providedPassword ? " (from SCADA_TEST_OPERATOR_PASSWORD)" : " (freshly generated -- not stored anywhere; copy it now)"}`);
  console.log(`  Site: ${result.siteName} (dedicated synthetic fixture, isolated from real plant data)`);
  console.log("  Role: viewer (dashboard/energy-analytics/historical-data only -- no export, device, site, or user administration)");
  console.log(`  Fixture saved-evidence snapshot seeded with ${result.parameterCount} parameters (KPI, summary, device, and raw evidence categories all represented).`);
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    return pool.end().finally(() => process.exit(1));
  });
