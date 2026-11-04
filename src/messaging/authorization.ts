import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export async function resolveWeixinInboundAuthorization(params: {
  senderId: string;
  ownerId?: string;
  rawBody: string;
  commands: {
    shouldComputeCommandAuthorized: (body: string, config: OpenClawConfig) => boolean;
  };
  config: OpenClawConfig;
}): Promise<{ senderAllowed: boolean; commandAuthorized: boolean | undefined }> {
  const shouldComputeCommand = params.commands.shouldComputeCommandAuthorized(
    params.rawBody,
    params.config,
  );

  const ownerId = params.ownerId?.trim();
  const ownerMatches = Boolean(ownerId && params.senderId === ownerId);
  const senderAllowed = !ownerId || ownerMatches;

  return {
    senderAllowed,
    commandAuthorized: shouldComputeCommand ? ownerMatches : undefined,
  };
}
