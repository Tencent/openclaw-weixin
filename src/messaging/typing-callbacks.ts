import type { createTypingCallbacks as CreateTypingCallbacks } from "openclaw/plugin-sdk/channel-message";

type ModuleImporter = (specifier: string) => Promise<unknown>;
const CHANNEL_OUTBOUND_MODULE = "openclaw/plugin-sdk/channel-outbound";
const LEGACY_CHANNEL_RUNTIME_MODULE = "openclaw/plugin-sdk/channel-runtime";

function isMissingPackageExport(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") ||
    /Missing .*plugin-sdk\/channel-outbound.* specifier/.test(error.message)
  );
}

export async function loadCreateTypingCallbacks(
  importModule: ModuleImporter = (specifier) => import(specifier),
): Promise<typeof CreateTypingCallbacks> {
  try {
    const module = await importModule(CHANNEL_OUTBOUND_MODULE) as {
      createTypingCallbacks: typeof CreateTypingCallbacks;
    };
    return module.createTypingCallbacks;
  } catch (error) {
    // Hosts before channel-outbound shipped still satisfy the plugin's >=2026.5.12 contract.
    if (!isMissingPackageExport(error)) throw error;
  }

  const legacyModule = await importModule(LEGACY_CHANNEL_RUNTIME_MODULE) as {
    createTypingCallbacks: typeof CreateTypingCallbacks;
  };
  return legacyModule.createTypingCallbacks;
}
