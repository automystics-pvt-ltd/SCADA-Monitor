# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

- The `SavedParameterAnalytics` component (Energy/Performance screens in `mqtt-scada-monitor`) only renders its KPI/summary/device-comparison sections for records whose `dataQuality` is `validated`. For the live TRN246/Modbus source, no saved parameter is ever self-declared `validated` (see `artifacts/api-server/src/lib/trn246-telemetry-calibration.ts`) — approved plant calibration profiles feed the *live* calculation panel, not the archived saved-evidence path. So on this project's real data, only the raw-evidence table + pagination sections render; empty KPI/summary/device sections there is expected, not a bug.

## Testing

- A durable SCADA test operator account exists for exercising authenticated SCADA screens (login, dashboard, Energy/Performance analytics) with the testing subagent: username `qa.operator`. It has least-privilege `viewer` access to exactly one dedicated synthetic fixture site (`QA Fixture Plant`, under its own fixture organization) — never a real managed site, and never `site-admin`. The fixture site is seeded with synthetic saved-parameter evidence that includes `validated` records, so it's the only place in this project where the `SavedParameterAnalytics` KPI/summary/device-comparison sections can be visually exercised (see Gotchas below for why real data can't).
- The account has no committed password. Run `pnpm --filter @workspace/scripts run provision-scada-test-operator` (script: `scripts/src/provision-scada-test-operator.ts`) to (re)provision it — it prints a freshly generated password to the console (or set `SCADA_TEST_OPERATOR_PASSWORD`, e.g. as a Replit Secret, for a stable password across runs). The script is idempotent, refuses to run when `NODE_ENV=production`, and revokes any site/org access this user has outside the fixture scope on every run so privilege can never drift or accumulate.
- A committed Playwright spec (`artifacts/mqtt-scada-monitor/e2e/scada-analytics.spec.ts`) logs in as `qa.operator` and asserts the KPI/summary/device/raw-evidence/pagination sections all render on the Energy and Performance screens. Its `global-setup.ts` (re)provisions the fixture (fresh window timestamps, so it always falls inside the saved-parameters API's rolling 48-hour server-side window) before the spec runs. With the API Server and MQTT SCADA Monitor workflows running, run `SCADA_E2E_BASE_URL=https://<this-repl's-dev-domain>/ pnpm --filter @workspace/mqtt-scada-monitor run test:e2e` to reverify after future changes to those screens.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
