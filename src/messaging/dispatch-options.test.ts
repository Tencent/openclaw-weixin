import { describe, expect, it } from "vitest";

import { withPublishedModelRuntime } from "./dispatch-options.js";

describe("withPublishedModelRuntime", () => {
  it("opts legacy Weixin dispatch into the Gateway-published model runtime", () => {
    const ctx = {} as never;
    const cfg = {} as never;
    const dispatcher = {} as never;

    const result = withPublishedModelRuntime({ ctx, cfg, dispatcher });

    expect(result).toMatchObject({
      ctx,
      cfg,
      dispatcher,
      usePublishedModelRuntime: true,
    });
  });
});
