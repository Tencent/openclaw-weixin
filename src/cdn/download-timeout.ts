export type DownloadOptions = {
  /** Cancel network reads when the channel stops. */
  abortSignal?: AbortSignal;
  /** Deadline includes response headers and the complete response body. */
  timeoutMs?: number;
};

const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Bound a complete download, including body consumption, and release on cancellation. */
export async function withDownloadTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: DownloadOptions,
  label: string,
): Promise<T> {
  options.abortSignal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("CDN download timeout must be a positive finite number");
  }
  const onCancel = () => controller.abort(options.abortSignal?.reason);
  options.abortSignal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(`${label}: CDN download timed out`, "TimeoutError")),
    timeoutMs,
  );
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Race as well as abort so a stalled transport cannot hold the caller indefinitely.
    return await Promise.race([aborted, run(controller.signal)]);
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onCancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
