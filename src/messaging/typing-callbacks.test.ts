import { describe, expect, it, vi } from "vitest";

import { loadCreateTypingCallbacks } from "./typing-callbacks.js";

function missingExportError(): Error {
  return Object.assign(new Error("Package subpath is not defined by exports"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
}

describe("loadCreateTypingCallbacks", () => {
  it("loads createTypingCallbacks from the installed host", async () => {
    await expect(loadCreateTypingCallbacks()).resolves.toEqual(expect.any(Function));
  });

  it("loads the canonical channel-outbound export", async () => {
    const createTypingCallbacks = vi.fn();
    const importModule = vi.fn().mockResolvedValue({ createTypingCallbacks });

    await expect(loadCreateTypingCallbacks(importModule)).resolves.toBe(createTypingCallbacks);
    expect(importModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith("openclaw/plugin-sdk/channel-outbound");
  });

  it("falls back for hosts that predate channel-outbound", async () => {
    const createTypingCallbacks = vi.fn();
    const importModule = vi
      .fn()
      .mockRejectedValueOnce(missingExportError())
      .mockResolvedValueOnce({ createTypingCallbacks });

    await expect(loadCreateTypingCallbacks(importModule)).resolves.toBe(createTypingCallbacks);
    expect(importModule).toHaveBeenNthCalledWith(1, "openclaw/plugin-sdk/channel-outbound");
    expect(importModule).toHaveBeenNthCalledWith(2, "openclaw/plugin-sdk/channel-runtime");
  });

  it("recognizes Vite's missing export error", async () => {
    const createTypingCallbacks = vi.fn();
    const importModule = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Missing "./plugin-sdk/channel-outbound" specifier in "openclaw" package',
        ),
      )
      .mockResolvedValueOnce({ createTypingCallbacks });

    await expect(loadCreateTypingCallbacks(importModule)).resolves.toBe(createTypingCallbacks);
  });

  it("does not hide failures from an available canonical module", async () => {
    const loadError = new Error("module initialization failed");
    const importModule = vi.fn().mockRejectedValue(loadError);

    await expect(loadCreateTypingCallbacks(importModule)).rejects.toBe(loadError);
    expect(importModule).toHaveBeenCalledOnce();
  });

});
