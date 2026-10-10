import { describe, expect, it, vi } from "vitest";

import plugin from "./index.js";

describe("plugin registration", () => {
  it("does not access runtime during CLI metadata registration", () => {
    const runtime = new Proxy(
      {},
      {
        get() {
          throw new Error('runtime is unavailable during "cli-metadata" registration');
        },
      },
    );
    const registerChannel = vi.fn();

    expect(() =>
      plugin.register({
        registrationMode: "cli-metadata",
        runtime,
        registerChannel,
      } as never),
    ).not.toThrow();
    expect(registerChannel).toHaveBeenCalledOnce();
  });
});
