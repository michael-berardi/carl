import type { CarlConfig } from "./config.ts";

/** A Telegram chat this Carl home may send to: its home chat, its allowed users and its configured groups. */
export function isOwnChat(cfg: Pick<CarlConfig, "telegram">, chatId: number): boolean {
  return cfg.telegram.allowFrom.includes(chatId) || chatId === cfg.telegram.homeChat || cfg.telegram.groups.some((g) => g.chat === chatId);
}

/**
 * The named refusal for a chat this bot is not configured for, or undefined when the send may go. Every send path
 * (the gateway's send and `carl send`) uses it: a bot that is not in a group cannot reach that group, and a client group
 * is reached only through the operator's reporting route, never by pointing another bot at its chat id.
 */
export function refuseUnconfiguredChat(cfg: CarlConfig, chatId: number): string | undefined {
  if (isOwnChat(cfg, chatId)) return undefined;
  const route = cfg.ultraterm
    ? " A client-group message goes through the reporting route: `utp report --route client --project <project>`."
    : " A client-group message goes through the operator's reporting route, not a direct send.";
  return `chat ${chatId} is not the home chat, an allowed user or a configured group of this bot, so it cannot send there.${route}`;
}
