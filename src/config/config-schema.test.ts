import { describe, it, expect } from "vitest";
import { WeixinConfigSchema } from "./config-schema.js";

describe("WeixinConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const result = WeixinConfigSchema.parse({});
    expect(result.baseUrl).toBe("https://ilinkai.weixin.qq.com");
    expect(result.cdnBaseUrl).toBe("https://novac2c.cdn.weixin.qq.com/c2c");
    expect(result.blockStreaming).toBe(true);
    expect(result.replyProgressMessages).toBe(true);
  });

  it("accepts custom baseUrl and cdnBaseUrl", () => {
    const result = WeixinConfigSchema.parse({
      baseUrl: "https://custom.api.com",
      cdnBaseUrl: "https://custom.cdn.com",
    });
    expect(result.baseUrl).toBe("https://custom.api.com");
    expect(result.cdnBaseUrl).toBe("https://custom.cdn.com");
  });

  it("accepts optional account fields", () => {
    const result = WeixinConfigSchema.parse({
      name: "my-bot",
      enabled: false,
      blockStreaming: false,
    });
    expect(result.name).toBe("my-bot");
    expect(result.enabled).toBe(false);
    expect(result.blockStreaming).toBe(false);
  });

  it("accepts disabling reply progress messages", () => {
    const result = WeixinConfigSchema.parse({
      replyProgressMessages: false,
    });
    expect(result.replyProgressMessages).toBe(false);
  });

  it("accepts accounts map", () => {
    const result = WeixinConfigSchema.parse({
      accounts: {
        "acc1": { name: "Bot 1", enabled: true, blockStreaming: false },
        "acc2": { name: "Bot 2" },
      },
    });
    expect(result.accounts?.acc1?.name).toBe("Bot 1");
    expect(result.accounts?.acc1?.blockStreaming).toBe(false);
    expect(result.accounts?.acc2?.name).toBe("Bot 2");
  });

  it("rejects invalid types", () => {
    expect(() => WeixinConfigSchema.parse({ enabled: "yes" })).toThrow();
  });
});
