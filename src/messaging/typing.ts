type TypingCallbacksFactory =
  typeof import("openclaw/plugin-sdk/channel-outbound").createTypingCallbacks;

const LEGACY_CHANNEL_MESSAGE: string = "openclaw/plugin-sdk/channel-message";
let factoryPromise: Promise<TypingCallbacksFactory> | undefined;

export function loadTypingCallbacksFactory(): Promise<TypingCallbacksFactory> {
  factoryPromise ??= import("openclaw/plugin-sdk/channel-outbound")
    .then(({ createTypingCallbacks }) => createTypingCallbacks)
    .catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        throw error;
      }
      const { createTypingCallbacks } = (await import(LEGACY_CHANNEL_MESSAGE)) as {
        createTypingCallbacks: TypingCallbacksFactory;
      };
      return createTypingCallbacks;
    });
  return factoryPromise;
}
