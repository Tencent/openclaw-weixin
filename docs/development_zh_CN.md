# 开发与本地验证

本文说明本项目常用的开发、测试和本地插件验证流程。

## 环境准备

确认 Node.js、npm、Git 和 OpenClaw 已安装：

```bash
node --version
npm --version
git --version
openclaw --version
```

Node.js 版本要求以 `package.json` 的 `engines` 配置为准。

## 创建 worktree

为独立功能或 PR 创建 worktree，避免影响当前工作目录：

```bash
PR_NUMBER=123  # replace with the actual PR number
WORKTREE_DIR="/tmp/openclaw-weixin-pr-${PR_NUMBER}"
REVIEW_BRANCH="review/pr-${PR_NUMBER}"

git fetch origin main
git fetch origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr-${PR_NUMBER}"
git worktree add -b "$REVIEW_BRANCH" "$WORKTREE_DIR" origin/main
cd "$WORKTREE_DIR"
git merge --no-ff "origin/pr-${PR_NUMBER}"
```

确认状态：

```bash
git branch --show-current
git status
```

## 处理合并冲突

查看冲突文件：

```bash
git status
git diff --name-only --diff-filter=U
```

编辑冲突文件，保留正确内容并删除 `<<<<<<<`、`=======`、`>>>>>>>` 标记，然后执行：

```bash
git add <已解决的文件>
git commit -m "resolve merge conflicts"
git diff --check
```

如果主分支有更新，可以重新同步：

```bash
git fetch origin main
git merge origin/main
```

## 安装依赖

在包含 `package.json` 和 `package-lock.json` 的项目根目录执行：

```bash
npm ci --ignore-scripts --include=dev
```

`npm ci` 按锁文件安装依赖，适合干净、可复现的测试环境。

修改依赖时使用 `npm install`，完成后提交更新后的 `package.json` 和 `package-lock.json`，再重新执行 `npm ci` 验证：

```bash
npm install --save-dev --save-exact <package>@<version>
npm ci --ignore-scripts --include=dev
```

安装警告不一定表示失败，应以命令退出码和最终结果为准。不要未经确认直接执行 `npm audit fix --force`。

## 执行质量检查

```bash
npm run ci
```

该命令会依次执行格式检查、Lint、类型检查、单元测试和构建。需要单独执行时：

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
```

## 打包本地插件

先在项目根目录完成构建，然后使用 `npm pack` 生成本地安装包：

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
test -n "$PACKAGE_TGZ" || { echo "找不到安装包"; exit 1; }
```

`PACKAGE_DIR` 是临时目录，`PACKAGE_TGZ` 是其中生成的 `.tgz` 文件。安装时必须使用后者。

## 安装并验证本地插件

```bash
openclaw plugins install "$PACKAGE_TGZ" \
  --force \
  --accept-capabilities

openclaw gateway restart
openclaw channels status
```

根据本次修改内容完成手工验证，例如消息收发、登录、媒体、配置、重启后状态和异常降级行为。

如不希望影响现有 OpenClaw 配置，可以在验证前使用独立的 `OPENCLAW_STATE_DIR`。

## 常见问题

- `uv_cwd` 或 `process.cwd`：当前目录已被删除，通常是停留在 `dist` 中执行构建；切回项目根目录。
- `Plugin install source must not be empty`：`PACKAGE_TGZ` 未设置或为空，重新执行打包流程。
- `HOOK.md missing`：把 `PACKAGE_DIR` 目录传给了安装器，应传入 `PACKAGE_TGZ` 文件。

## 提交前检查

```bash
git status
git diff --check
npm run ci
```

确认代码、测试和文档无误后再提交。版本发布应使用项目既有的版本发布流程，并在合并后单独进行。
