import {
  DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
  MAX_DOWNLOAD_TIMEOUT_MS,
} from "../config/media-download.js";

export type DownloadOptions = {
  /** Cancel network reads when the channel stops. */
  abortSignal?: AbortSignal;
  /** Optional total deadline, including headers and body. Zero means unlimited. */
  timeoutMs?: number;
  /** Maximum time without headers or a non-empty body chunk. */
  idleTimeoutMs?: number;
};

/** Bound inactivity, optional total duration, and release on cancellation. */
export async function withDownloadTimeout<T>(
  run: (signal: AbortSignal, onProgress: () => void) => Promise<T>,
  options: DownloadOptions,
  label: string,
): Promise<T> {
  options.abortSignal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_DOWNLOAD_TIMEOUT_MS) {
    throw new RangeError("CDN download timeout must be a non-negative timer duration");
  }
  if (
    !Number.isInteger(idleTimeoutMs) ||
    idleTimeoutMs <= 0 ||
    idleTimeoutMs > MAX_DOWNLOAD_TIMEOUT_MS
  ) {
    throw new RangeError("CDN download idle timeout must be a positive timer duration");
  }
  const controller = new AbortController();
  const onCancel = () => controller.abort(options.abortSignal?.reason);
  options.abortSignal?.addEventListener("abort", onCancel, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () =>
            controller.abort(new DOMException(`${label}: CDN download timed out`, "TimeoutError")),
          timeoutMs,
        )
      : undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onProgress = () => {
    clearTimeout(idleTimer);
    if (controller.signal.aborted) return;
    idleTimer = setTimeout(
      () => controller.abort(new DOMException(`${label}: CDN download stalled`, "TimeoutError")),
      idleTimeoutMs,
    );
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  onProgress();
  try {
    // Race as well as abort so a stalled transport cannot hold the caller indefinitely.
    return await Promise.race([aborted, run(controller.signal, onProgress)]);
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    options.abortSignal?.removeEventListener("abort", onCancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Observe body progress and cancel pending reads on transports ignoring signals. */
export async function readDownloadBody(
  response: Response,
  signal: AbortSignal,
  onProgress: () => void,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    return Buffer.from(bytes);
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength === 0) continue;
      onProgress();
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
