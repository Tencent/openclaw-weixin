# CI Guide

This document describes the local quality checks and GitHub Actions workflow for contributors and maintainers.

## Local checks

The project requires Node.js `>=22.13.0`. After cloning the repository or changing dependencies, install the locked dependencies first:

```bash
npm ci --ignore-scripts
```

Run the local quality checks:

```bash
npm run ci
```

`npm run ci` runs the format check, lint, TypeScript typecheck, unit tests, and build. Run the coverage check separately:

```bash
npm run test:coverage
```

## GitHub Actions

The workflow is defined in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and runs for:

- Pull requests;
- pushes to `main`;
- manual dispatches.

Each job installs dependencies in a clean environment with `npm ci --ignore-scripts`. npm caching is enabled, but dependency versions are determined by `package-lock.json`.

### CI jobs

| Job | Checks |
| --- | --- |
| `quality` | Format check, lint, typecheck, and build |
| `unit-node-22` | Unit tests on Node.js 22 |
| `unit-node-24` | Unit tests on Node.js 24 |
| `coverage` | Coverage thresholds and report upload |
| `package-smoke` | Build output and npm package contents |

The package smoke test verifies that the npm package contains `dist/index.js` and does not contain test source files or other development-only files.

### Required checks

Repository maintainers can configure the following stable checks as required checks in the GitHub ruleset for the `main` branch:

```text
quality
unit-node-22
unit-node-24
coverage
package-smoke
```

If a job's `name` changes, review the required checks in the ruleset as well so branch protection does not reference an obsolete check name.

## Dependency upgrades

Upgrade dependencies in a separate branch and review both `package.json` and `package-lock.json`:

```bash
npm outdated
npm install --save-dev <package>@<version>
git diff -- package.json package-lock.json
npm run ci
npm run test:coverage
```

Do not edit `package-lock.json` manually or run `npm update` in CI. Submit dependency upgrades through a pull request so CI can validate them before merging.

## Security boundaries

- CI has only `contents: read` permissions by default;
- Regular pull requests use the `pull_request` trigger;
- CI does not read real WeChat accounts, tokens, or production secrets;
- Third-party GitHub Actions are pinned to full commit SHAs;
- Live WeChat flows and live E2E tests are not part of the regular pull request gate.

## Troubleshooting

### `npm ci` reports a lockfile mismatch

Make sure `package.json` and `package-lock.json` are committed together. If only `package.json` was changed, run `npm install` locally to update the lockfile, then run the complete CI checks.

### `npm run ci` cannot find `oxlint` or `vitest`

Run the dependency installation first:

```bash
npm ci --ignore-scripts
```

Project scripts use the tools in the local `node_modules/.bin` directory and do not depend on globally installed versions.

### Coverage checks fail

Run `npm run test:coverage` to inspect uncovered branches. Prefer adding tests with business value instead of lowering the global coverage thresholds.
