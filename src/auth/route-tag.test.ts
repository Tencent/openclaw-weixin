import { describe, expect, it } from "vitest";

import { appendCradleHostname, cradleHostname } from "./route-tag.js";

describe("cradleHostname", () => {
  it("prefixes the route tag with g", () => {
    expect(cradleHostname("10086")).toBe("g10086");
    expect(cradleHostname("g10086")).toBe("g10086");
    expect(cradleHostname("  ")).toBeUndefined();
    expect(cradleHostname(undefined)).toBeUndefined();
  });
});

describe("appendCradleHostname", () => {
  it("adds the query param without dropping existing parameters", () => {
    const url = new URL("https://ilinkai.weixin.qq.com/ilink/bot/getupdates?bot_type=3");
    appendCradleHostname(url, "10086");
    expect(url.searchParams.get("bot_type")).toBe("3");
    expect(url.searchParams.get("_cradle_hostname")).toBe("g10086");
  });

  it("leaves the URL unchanged when no route tag is configured", () => {
    const url = new URL("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
    appendCradleHostname(url, undefined);
    expect(url.search).toBe("");
  });
});
