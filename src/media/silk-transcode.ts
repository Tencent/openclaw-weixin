import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../util/logger.js";

/** Default sample rate for Weixin voice messages (SILK_V3). */
export const SILK_SAMPLE_RATE = 16_000;

/** proto VoiceItem.encode_type */
export const VoiceEncodeType = {
  PCM: 1,
  ADPCM: 2,
  FEATURE: 3,
  SPEEX: 4,
  AMR: 5,
  SILK: 6,
  MP3: 7,
  OGG_SPEEX: 8,
} as const;

const SILK_MAGIC = Buffer.from("#!SILK_V3");
const TENCENT_SILK_PREFIX = 0x02;

/**
 * Wrap raw pcm_s16le bytes in a WAV container.
 * Mono channel, 16-bit signed little-endian.
 */
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;

  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;

  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4; // fmt chunk size
  buf.writeUInt16LE(1, offset);
  offset += 2; // PCM format
  buf.writeUInt16LE(1, offset);
  offset += 2; // mono
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset);
  offset += 4; // byte rate (mono 16-bit)
  buf.writeUInt16LE(2, offset);
  offset += 2; // block align
  buf.writeUInt16LE(16, offset);
  offset += 2; // bits per sample

  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);

  return buf;
}

/** True when `buf` is Tencent SILK (`#!SILK_V3` or `\x02#!SILK_V3`). */
export function ensureTencentSilk(buf: Buffer): Buffer {
  if (buf.length >= SILK_MAGIC.length + 1 && buf[0] === TENCENT_SILK_PREFIX && buf.subarray(1, 1 + SILK_MAGIC.length).equals(SILK_MAGIC)) {
    return buf;
  }
  if (buf.length >= SILK_MAGIC.length && buf.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)) {
    return Buffer.concat([Buffer.from([TENCENT_SILK_PREFIX]), buf]);
  }
  return buf;
}

export function isSilkBuffer(buf: Buffer): boolean {
  if (buf.length >= SILK_MAGIC.length && buf.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)) {
    return true;
  }
  return (
    buf.length >= SILK_MAGIC.length + 1 &&
    buf[0] === TENCENT_SILK_PREFIX &&
    buf.subarray(1, 1 + SILK_MAGIC.length).equals(SILK_MAGIC)
  );
}

/**
 * Try to transcode a SILK audio buffer to WAV using silk-wasm.
 * silk-wasm's decode() returns { data: Uint8Array (pcm_s16le), duration: number }.
 *
 * Returns a WAV Buffer on success, or null if silk-wasm is unavailable or decoding fails.
 * Callers should fall back to passing the raw SILK file when null is returned.
 */
export async function silkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import("silk-wasm");

    logger.debug(`silkToWav: decoding ${silkBuf.length} bytes of SILK`);
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    logger.debug(
      `silkToWav: decoded duration=${result.duration}ms pcmBytes=${result.data.byteLength}`,
    );

    const wav = pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
    logger.debug(`silkToWav: WAV size=${wav.length}`);
    return wav;
  } catch (err) {
    logger.warn(`silkToWav: transcode failed, will use raw silk err=${String(err)}`);
    return null;
  }
}

/* v8 ignore start -- ffmpeg discovery/spawn; live-tested on ken-mac */
function resolveFfmpeg(): string | null {
  if (process.env.WEIXIN_SKIP_FFMPEG === "1") return null;
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ].filter((p): p is string => Boolean(p));
  for (const cand of candidates) {
    if (cand === "ffmpeg") return cand;
    if (existsSync(cand)) return cand;
  }
  return null;
}

/* v8 ignore start -- spawns host ffmpeg; covered in live send, not unit tests */
function runFfmpegToWav(inputPath: string, ffmpegBin: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", String(SILK_SAMPLE_RATE), "-f", "wav", "pipe:1"];
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out converting audio to WAV"));
    }, 30_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errText = Buffer.concat(stderr).toString("utf8").slice(-800);
        reject(new Error(`ffmpeg exited ${code}: ${errText}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

export type OutboundVoiceMeta = {
  /** Absolute path to a SILK file ready for CDN upload. */
  filePath: string;
  playtimeMs: number;
  sampleRate: number;
  encodeType: number;
  bitsPerSample: number;
  /** Delete temp files created during transcode. */
  cleanup: () => Promise<void>;
};

/**
 * Prepare a local audio file for Weixin native VOICE send.
 * Already-SILK files are used as-is; anything else is transcoded to
 * 16 kHz mono SILK_V3 via ffmpeg (WAV) + silk-wasm (encode), matching inbound WeChat voice bubbles.
 */
export async function prepareOutboundVoice(filePath: string): Promise<OutboundVoiceMeta> {
  const src = await fs.readFile(filePath);
  const temps: string[] = [];
  const cleanup = async () => {
    for (const p of temps) {
      await fs.unlink(p).catch(() => undefined);
    }
  };

  if (isSilkBuffer(src)) {
    const tencent = ensureTencentSilk(src);
    if (tencent.length !== src.length || tencent[0] !== src[0]) {
      const prefixed = path.join(os.tmpdir(), `weixin-voice-prefixed-${process.pid}-${Date.now()}.silk`);
      await fs.writeFile(prefixed, tencent);
      temps.push(prefixed);
      filePath = prefixed;
    }
    let playtimeMs = 0;
    try {
      const { getDuration } = await import("silk-wasm");
      playtimeMs = Math.max(1, Math.round(getDuration(src)));
    } catch (err) {
      logger.warn(`prepareOutboundVoice: silk duration failed err=${String(err)}`);
      playtimeMs = Math.max(1, Math.round((src.length / 2500) * 1000));
    }
    logger.info(
      `prepareOutboundVoice: already SILK path=${filePath} bytes=${src.length} playtimeMs=${playtimeMs}`,
    );
    return {
      filePath,
      playtimeMs,
      sampleRate: SILK_SAMPLE_RATE,
      encodeType: VoiceEncodeType.SPEEX,
      bitsPerSample: 16,
      cleanup,
    };
  }

  const ffmpegBin = resolveFfmpeg();
  let wavBuf: Buffer;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav" && src.length > 44 && src.subarray(0, 4).toString("ascii") === "RIFF") {
    wavBuf = src;
  } else if (ffmpegBin) {
    logger.info(`prepareOutboundVoice: ffmpeg ${ffmpegBin} → ${SILK_SAMPLE_RATE}Hz mono WAV from ${filePath}`);
    wavBuf = await runFfmpegToWav(filePath, ffmpegBin);
  /* v8 ignore stop */
  } else {
    await cleanup();
    throw new Error(
      "prepareOutboundVoice: ffmpeg not found; install ffmpeg to send non-SILK audio as a native voice bubble",
    );
  }

  try {
    const { encode } = await import("silk-wasm");
    const encoded = await encode(wavBuf, SILK_SAMPLE_RATE);
    const silkBuf = ensureTencentSilk(Buffer.from(encoded.data));
    const playtimeMs = Math.max(1, Math.round(encoded.duration || 0));
    const outPath = path.join(os.tmpdir(), `weixin-voice-${process.pid}-${Date.now()}.silk`);
    await fs.writeFile(outPath, silkBuf);
    temps.push(outPath);
    logger.info(
      `prepareOutboundVoice: encoded SILK path=${outPath} bytes=${silkBuf.length} playtimeMs=${playtimeMs}`,
    );
    return {
      filePath: outPath,
      playtimeMs,
      sampleRate: SILK_SAMPLE_RATE,
      encodeType: VoiceEncodeType.SPEEX,
      bitsPerSample: 16,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw new Error(`prepareOutboundVoice: silk-wasm encode failed: ${String(err)}`);
  }
}

export function isWeixinAudioFilename(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".silk", ".slk", ".amr", ".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac", ".pcm", ".aiff", ".aif"].includes(
    ext,
  );
}
