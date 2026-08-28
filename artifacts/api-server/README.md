# API Server

## Type checking

Run the package check directly:

```sh
pnpm --filter @workspace/api-server exec tsc --noEmit -p .
```

This package intentionally does not declare TypeScript project references to
`lib/db` or `lib/api-zod`. Both workspace packages expose their TypeScript
source through their package export maps, so bundler module resolution can
type-check those imports directly.

Adding project references changes TypeScript's behavior: API-server imports are
redirected to the referenced projects' generated `dist/*.d.ts` files. Those
files are ignored build artifacts and may be missing or older than the source.
That previously made a valid new database export appear absent until the
library declaration output was rebuilt. Keeping source-exported workspace
packages out of this package's `references` makes the standalone check
independent of generated declaration state. The root `pnpm typecheck` command
still builds the library projects through the root solution configuration.