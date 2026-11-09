import { logger } from "../util/logger.js";

export type BindOwnerMode = "self" | "other";

export const PROMPT_OWNER = "连接此 OpenClaw 到你本人的微信 ClawBot？直接回车默认为 Y [Y/n] ";
export const PROMPT_REALNAME =
  "请用你本人的手机微信扫描以下二维码，完成实名信息授权以连接此 OpenClaw 到他人的微信 ClawBot\n";
export const PROMPT_BIND = "让连接此 OpenClaw 的用户用手机微信扫描以下二维码\n";

export function parseOwnerChoice(raw: string): BindOwnerMode | "invalid" {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "y") return "self";
  if (value === "n") return "other";
  return "invalid";
}

export async function readOwnerChoice(opts: {
  readLine: () => Promise<string>;
  write: (chunk: string) => void;
}): Promise<BindOwnerMode> {
  for (;;) {
    opts.write(PROMPT_OWNER);
    const raw = await opts.readLine();
    const choice = parseOwnerChoice(raw);
    if (choice !== "invalid") return choice;
    logger.info(`owner choice invalid, re-prompting raw=${JSON.stringify(raw.slice(0, 40))}`);
  }
}
