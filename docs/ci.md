# CI 指南

本文说明本项目的本地质量检查和 GitHub Actions CI 流程，供贡献者排查问题和维护 CI 配置时参考。

## 本地检查

项目要求 Node.js `>=22`。首次获取代码或依赖发生变化后，先安装 lockfile 中锁定的依赖：

```bash
npm ci --ignore-scripts
```

运行本地质量检查：

```bash
npm run ci
```

`npm run ci` 包含格式检查、Lint、TypeScript 类型检查、单元测试和构建。覆盖率检查单独执行：

```bash
npm run test:coverage
```

## GitHub Actions

workflow 文件位于 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)，会在以下场景运行：

- Pull Request；
- 推送到 `main`；
- 手动触发。

每个 job 都会在干净环境中执行 `npm ci --ignore-scripts`。workflow 使用 npm cache，但依赖版本以 `package-lock.json` 为准。

### CI jobs

| Job | 主要检查 |
| --- | --- |
| `quality` | format check、Lint、typecheck、build |
| `unit-node-22` | Node.js 22 单元测试 |
| `unit-node-24` | Node.js 24 单元测试 |
| `coverage` | 覆盖率门槛和报告上传 |
| `package-smoke` | 构建产物和 npm 包文件清单 |

包冒烟检查会确认 npm 包包含 `dist/index.js`，并且不包含测试源码等开发文件。

### Required checks

仓库维护者可以在 GitHub main 分支 ruleset 中将以下稳定检查设置为 required：

```text
quality
unit-node-22
unit-node-24
coverage
package-smoke
```

修改 job 的 `name` 时，应同步检查 ruleset 中的 required check，避免分支保护引用失效的名称。

## 依赖升级

依赖升级应在独立分支中进行，并同时审查 `package.json` 和 `package-lock.json`：

```bash
npm outdated
npm install --save-dev <package>@<version>
git diff -- package.json package-lock.json
npm run ci
npm run test:coverage
```

不要手动编辑 `package-lock.json`，也不要在 CI 中使用 `npm update`。依赖升级通过 Pull Request 提交，由 CI 验证后再合并。

## 安全边界

- CI 默认只授予 `contents: read` 权限；
- 普通 Pull Request 使用 `pull_request` 触发器；
- CI 不读取真实微信账号、Token 或线上环境 secrets；
- 第三方 GitHub Actions 固定到完整 commit SHA；
- 真实微信链路和 live E2E 不属于普通 PR 门禁。

## 常见问题

### `npm ci` 报 lockfile 不一致

确认 `package.json` 和 `package-lock.json` 一起提交。如果只是修改了 `package.json`，可以先在本地执行 `npm install` 更新 lockfile，再运行完整 CI 检查。

### `npm run ci` 找不到 `oxlint` 或 `vitest`

先执行：

```bash
npm ci --ignore-scripts
```

项目脚本会优先使用本地 `node_modules/.bin` 中的工具，不依赖全局安装版本。

### 覆盖率检查失败

运行 `npm run test:coverage` 查看未覆盖分支。优先补充有业务价值的测试，不要通过降低全局覆盖率门槛隐藏缺失测试。
