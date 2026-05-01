export async function applyWeixinMessageSendingHook(params: {
  to: string;
  text: string;
  accountId: string;
  mediaUrl?: string;
}) {
  return { cancelled: false, text: params.text };
}

export function emitWeixinMessageSent(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  accountId: string;
}) {
  // no-op
}
