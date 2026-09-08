# Development and Local Validation

This guide describes the common workflow for developing, testing, and locally validating this project.

## Prerequisites

Make sure Node.js, npm, Git, and OpenClaw are installed:

```bash
node --version
npm --version
git --version
openclaw --version
```

The required Node.js version is defined by the `engines` field in `package.json`.

## Create a worktree

Use a separate worktree for an independent feature or pull request:

```bash
PR_NUMBER=123  # replace with the actual pull request number
WORKTREE_DIR="/tmp/openclaw-weixin-pr-${PR_NUMBER}"
REVIEW_BRANCH="review/pr-${PR_NUMBER}"

git fetch origin main
git fetch origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr-${PR_NUMBER}"
git worktree add -b "$REVIEW_BRANCH" "$WORKTREE_DIR" origin/main
cd "$WORKTREE_DIR"
git merge --no-ff "origin/pr-${PR_NUMBER}"
```

Check the current worktree and branch:

```bash
git branch --show-current
git status
```

## Resolve merge conflicts

List conflicted files:

```bash
git status
git diff --name-only --diff-filter=U
```

Edit the files, keep the correct content, and remove the `<<<<<<<`, `=======`, and `>>>>>>>` markers. Then finish the merge:

```bash
git add <resolved files>
git commit -m "resolve merge conflicts"
git diff --check
```

To synchronize with a newer main branch:

```bash
git fetch origin main
git merge origin/main
```

## Install dependencies

Run the command from the project root, where `package.json` and `package-lock.json` are located:

```bash
npm ci --ignore-scripts --include=dev
```

`npm ci` installs the versions recorded in the lockfile and is suitable for clean, reproducible validation.

When changing dependencies, use `npm install`, commit both dependency files, and run `npm ci` again:

```bash
npm install --save-dev --save-exact <package>@<version>
npm ci --ignore-scripts --include=dev
```

Installation warnings do not necessarily mean that installation failed. Check the command exit code and final result. Do not run `npm audit fix --force` without reviewing the changes it would make.

## Run quality checks

Run the complete check:

```bash
npm run ci
```

This runs formatting, linting, type checking, unit tests, and the build. To run them separately:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

Run coverage separately when needed:

```bash
npm run test:coverage
```

## Pack the local plugin

Build from the project root, then create a local npm package:

```bash
npm run build

PACKAGE_DIR=$(mktemp -d /tmp/openclaw-weixin-package.XXXXXX)
npm pack --pack-destination "$PACKAGE_DIR"

PACKAGE_TGZ=$(find "$PACKAGE_DIR" \
  -maxdepth 1 \
  -type f \
  -name '*.tgz' \
  -print \
  -quit)

echo "$PACKAGE_TGZ"
test -n "$PACKAGE_TGZ" || { echo "Package not found"; exit 1; }
```

`PACKAGE_DIR` is the temporary directory. `PACKAGE_TGZ` is the `.tgz` file generated inside it and must be passed to the installer.

## Install and validate the local package

```bash
openclaw plugins install "$PACKAGE_TGZ" \
  --force \
  --accept-capabilities

openclaw gateway restart
openclaw channels status
```

Perform manual checks relevant to the change, such as login, message delivery, media handling, configuration, restart behavior, and failure fallback.

To avoid changing an existing OpenClaw configuration, use a separate `OPENCLAW_STATE_DIR` during validation.

## Common issues

- `uv_cwd` or `process.cwd`: the current directory was deleted, often because the shell was inside `dist` while the build cleaned it. Change back to the project root.
- `Plugin install source must not be empty`: `PACKAGE_TGZ` is unset or empty. Run the packaging commands again.
- `HOOK.md missing`: the temporary `PACKAGE_DIR` directory was passed to the installer instead of the `PACKAGE_TGZ` archive.

## Before committing

```bash
git status
git diff --check
npm run ci
```

Review the code, tests, and documentation before committing. Use the repository's established release process for versioning and publish packages separately after the change is merged.
