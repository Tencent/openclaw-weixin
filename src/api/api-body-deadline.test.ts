import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../util/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("../auth/accounts.js", () => ({
  loadConfigBotAgent: () => undefined,
  loadConfigRouteTag: () => undefined,
}));
import { apiGetFetch, apiPostFetch, sendMessage } from "./api.js";

let server: http.Server;
let baseUrl: string;
beforeEach(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ret":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("API response body deadline", () => {
  it("aborts a POST whose headers arrived but body stalled", async () => {
    await expect(
      apiPostFetch({ baseUrl, endpoint: "test", body: "{}", timeoutMs: 40, label: "test" }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("aborts a GET whose headers arrived but body stalled", async () => {
    await expect(
      apiGetFetch({ baseUrl, endpoint: "test", timeoutMs: 40, label: "test" }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("forwards channel cancellation through message sends", async () => {
    const controller = new AbortController();
    const pending = sendMessage({
      baseUrl,
      abortSignal: controller.signal,
      timeoutMs: 5000,
      body: { msg: {} },
    });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
