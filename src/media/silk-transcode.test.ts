import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("silkToWav", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when silk-wasm is unavailable", async () => {
    vi.doMock("silk-wasm", () => {
      throw new Error("Cannot find module 'silk-wasm'");
    });
    const { silkToWav } = await import("./silk-transcode.js");
    const result = await silkToWav(Buffer.from("fake-silk"));
    expect(result).toBeNull();
  });

  it("transcodes silk to WAV successfully", async () => {
    const fakePcm = new Uint8Array(480); // 10ms at 24kHz mono 16-bit
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn().mockResolvedValue({
        data: fakePcm,
        duration: 10,
      }),
    }));
    const { silkToWav } = await import("./silk-transcode.js");
    const result = await silkToWav(Buffer.from("fake-silk"));
    expect(result).not.toBeNull();
    expect(result!.length).toBe(44 + fakePcm.byteLength); // WAV header + PCM data

    // Verify WAV header
    expect(result!.toString("ascii", 0, 4)).toBe("RIFF");
    expect(result!.toString("ascii", 8, 12)).toBe("WAVE");
    expect(result!.toString("ascii", 12, 16)).toBe("fmt ");
    expect(result!.readUInt16LE(20)).toBe(1); // PCM format
    expect(result!.readUInt16LE(22)).toBe(1); // mono
    expect(result!.readUInt32LE(24)).toBe(24000); // sample rate
    expect(result!.readUInt16LE(34)).toBe(16); // bits per sample
    expect(result!.toString("ascii", 36, 40)).toBe("data");
  });

  it("returns null when decode fails", async () => {
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn().mockRejectedValue(new Error("decode error")),
    }));
    const { silkToWav } = await import("./silk-transcode.js");
    const result = await silkToWav(Buffer.from("bad-silk"));
    expect(result).toBeNull();
  });
});
