## Problem

On Node.js 24 with a CommonJS Gateway host, the plugin silently fails to load.

**Root cause chain:**

1. OpenClaw's plugin loader calls `require()` on `dist/index.js` first (synchronous native load).
2. `dist/index.js` is ESM (`"type": "module"`), so `require()` throws `ERR_REQUIRE_ESM`.
3. The loader falls back to **jiti** (source-transform mode) to handle ESM files.
4. jiti 2.7.0 crashes on Node.js 24 with:
   ```
   Cannot read properties of undefined (reading 'createRequire')
   ```
5. The plugin is marked as failed; no channel is registered; no error surfaced to the user.

## Fix

Add a pre-built CJS bundle (`dist-cjs/index.cjs`) generated with **esbuild**:

- `openclaw`, `@openclaw`, `zod`, and `qrcode-terminal` are marked `--external` so the bundle stays small (~174 KB) and uses the host's copies at runtime.
- `import.meta.url` is shimmed with `require('url').pathToFileURL(__filename).href` so the one internal usage (`src/api/api.ts`) resolves correctly.
- `dist-cjs/index.cjs` is added as the **first** entry in `openclaw.runtimeExtensions`. OpenClaw picks the first file that loads successfully; on CommonJS hosts `require('./dist-cjs/index.cjs')` succeeds natively — no jiti involved. On ESM hosts the existing `dist/index.js` entry is used as before.

### Changes

| File | Change |
|------|--------|
| `package.json` | Add `dist-cjs/` to `files`; prepend `./dist-cjs/index.cjs` to `runtimeExtensions`; add `build:cjs` script; add `esbuild` devDependency |
| `dist-cjs/index.cjs` | New esbuild CJS bundle (committed for zero-install convenience) |

## Testing

### Verify `require()` loads cleanly

```bash
cd openclaw-weixin
node -e "
  const m = require('./dist-cjs/index.cjs');
  const def = m.default || m;
  console.assert(def.id === 'openclaw-weixin');
  console.assert(typeof def.register === 'function');
  console.log('OK:', def.id, def.name);
"
```

Expected output:
```
OK: openclaw-weixin Weixin
```

### Rebuild and re-verify

```bash
npm run build
node -e "const m = require('./dist-cjs/index.cjs'); console.log((m.default||m).id)"
```

### End-to-end (Node 24 Gateway)

1. Install the patched package into an OpenClaw Gateway running Node.js ≥ 24.
2. Enable the `openclaw-weixin` channel in config.
3. Confirm the channel appears in `openclaw gateway status` with `status: active` (no `ERR_REQUIRE_ESM` or jiti crash in logs).

## Notes

- This is a **pure additive** change: existing ESM hosts are unaffected.
- The `dist-cjs/` output is committed so consumers don't need a build step after `npm install`.
- Once OpenClaw ships a jiti version compatible with Node 24, or exposes a native async-import path for plugins, this shim can be removed.
