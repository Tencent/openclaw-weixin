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
    expect(result!.readUInt32LE(24)).toBe(16000); // sample rate
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

describe("isSilkBuffer", () => {
  it("detects raw and Tencent-prefixed SILK magic", async () => {
    const { isSilkBuffer } = await import("./silk-transcode.js");
    const magic = Buffer.from("#!SILK_V3more");
    expect(isSilkBuffer(magic)).toBe(true);
    expect(isSilkBuffer(Buffer.concat([Buffer.from([0x02]), magic]))).toBe(true);
    expect(isSilkBuffer(Buffer.from("RIFF"))).toBe(false);
  });
});

describe("isWeixinAudioFilename", () => {
  it("recognizes voice extensions", async () => {
    const { isWeixinAudioFilename } = await import("./silk-transcode.js");
    expect(isWeixinAudioFilename("/tmp/a.mp3")).toBe(true);
    expect(isWeixinAudioFilename("/tmp/a.silk")).toBe(true);
    expect(isWeixinAudioFilename("/tmp/a.pdf")).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function writeSilentWav(filePath: string, sampleRate = 16000, ms = 40): void {
  const samples = Math.round(sampleRate * (ms / 1000));
  const pcmBytes = samples * 2;
  const buf = Buffer.alloc(44 + pcmBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcmBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcmBytes, 40);
  fs.writeFileSync(filePath, buf);
}

describe("prepareOutboundVoice", () => {
  it("passes through existing SILK files", async () => {
    vi.resetModules();
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn(),
      getDuration: vi.fn().mockReturnValue(1234),
    }));
    const { prepareOutboundVoice } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `silk-in-${process.pid}.silk`);
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(80)]));
    try {
      const meta = await prepareOutboundVoice(tmp);
      expect(fs.readFileSync(meta.filePath)[0]).toBe(0x02);
      expect(meta.filePath).not.toBe(tmp);
      expect(meta.encodeType).toBe(4);
      expect(meta.playtimeMs).toBe(1234);
      expect(meta.sampleRate).toBe(16000);
      await meta.cleanup();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("encodes a WAV file to SILK via silk-wasm", async () => {
    vi.resetModules();
    const fakeSilk = Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(40)]);
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn().mockResolvedValue({ data: fakeSilk, duration: 40 }),
      getDuration: vi.fn(),
    }));
    const { prepareOutboundVoice, isSilkBuffer } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `wav-in-${process.pid}.wav`);
    writeSilentWav(tmp);
    try {
      const meta = await prepareOutboundVoice(tmp);
      expect(meta.encodeType).toBe(4);
      expect(meta.playtimeMs).toBe(40);
      expect(isSilkBuffer(fs.readFileSync(meta.filePath))).toBe(true);
      await meta.cleanup();
      expect(fs.existsSync(meta.filePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe("prepareOutboundVoice error paths", () => {
  it("throws when non-SILK input has no ffmpeg", async () => {
    vi.resetModules();
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn(),
      getDuration: vi.fn(),
    }));
    process.env.WEIXIN_SKIP_FFMPEG = "1";
    const { prepareOutboundVoice } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `mp3-in-${process.pid}.mp3`);
    fs.writeFileSync(tmp, "not-a-real-mp3");
    try {
      await expect(prepareOutboundVoice(tmp)).rejects.toThrow(/ffmpeg not found/);
    } finally {
      delete process.env.WEIXIN_SKIP_FFMPEG;
      fs.rmSync(tmp, { force: true });
    }
  });

  it("throws when silk-wasm encode fails", async () => {
    vi.resetModules();
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn().mockRejectedValue(new Error("encode boom")),
      getDuration: vi.fn(),
    }));
    const { prepareOutboundVoice } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `wav-fail-${process.pid}.wav`);
    writeSilentWav(tmp);
    try {
      await expect(prepareOutboundVoice(tmp)).rejects.toThrow(/silk-wasm encode failed/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("falls back on silk duration errors", async () => {
    vi.resetModules();
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn(),
      getDuration: vi.fn(() => {
        throw new Error("duration boom");
      }),
    }));
    const { prepareOutboundVoice } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `silk-dur-${process.pid}.silk`);
    const body = Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(80)]);
    fs.writeFileSync(tmp, body);
    try {
      const meta = await prepareOutboundVoice(tmp);
      expect(meta.playtimeMs).toBeGreaterThan(0);
      await meta.cleanup();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

  it("duration zero still yields playtime 1", async () => {
    vi.resetModules();
    const fakeSilk = Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.alloc(40)]);
    vi.doMock("silk-wasm", () => ({
      decode: vi.fn(),
      encode: vi.fn().mockResolvedValue({ data: fakeSilk, duration: 0 }),
      getDuration: vi.fn(),
    }));
    const { prepareOutboundVoice } = await import("./silk-transcode.js");
    const tmp = path.join(os.tmpdir(), `wav-zero-${process.pid}.wav`);
    writeSilentWav(tmp);
    try {
      const meta = await prepareOutboundVoice(tmp);
      expect(meta.playtimeMs).toBe(1);
      await meta.cleanup();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

describe("ensureTencentSilk", () => {
  it("prepends 0x02 to raw #!SILK_V3 and is idempotent", async () => {
    const { ensureTencentSilk } = await import("./silk-transcode.js");
    const raw = Buffer.concat([Buffer.from("#!SILK_V3"), Buffer.from([1, 2, 3])]);
    const out = ensureTencentSilk(raw);
    expect(out[0]).toBe(0x02);
    expect(out.subarray(1, 10).toString("ascii")).toBe("#!SILK_V3");
    expect(ensureTencentSilk(out)).toBe(out);
  });
});
