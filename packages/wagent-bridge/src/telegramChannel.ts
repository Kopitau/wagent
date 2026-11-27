// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Pure non-Effect Telegram channel coordinates long-polling and dual-surface deletion approvals.
import * as NodePath from "node:path";

import type { ApprovalHub, ApprovalHubEvent } from "./approvalHub.ts";
import { chunks } from "./telegram.ts";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramPort,
  TelegramUpdate,
} from "./telegram.ts";
import type { WagentPendingApproval, WagentRunRecord } from "./types.ts";

export interface TelegramChannelRuntimePort {
  readonly getAllowedUserIds: () => ReadonlyArray<number>;
  readonly getInboxDir: () => string;
  readonly getSummaryStatus: () => string;
  readonly dispatchFromTelegram: (input: {
    readonly prompt: string;
    readonly chatId: number;
    readonly onFile?: (filePath: string, caption?: string) => Promise<void>;
  }) => Promise<WagentRunRecord>;
  readonly abortActive: () => Promise<boolean>;
  readonly resetSession: () => Promise<void>;
}

function formatDecisionLabel(approval: WagentPendingApproval): string {
  if (approval.status === "approved") {
    const source = approval.decidedBy === "telegram" ? "Telegram" : "T3 UI";
    return `✅ 已允许（${source}）`;
  }
  if (approval.status === "timed_out") {
    return "⏰ 已超时自动拒绝";
  }
  if (approval.status === "cancelled") {
    return "🛑 任务已中止，自动拒绝";
  }
  const source = approval.decidedBy === "telegram" ? "Telegram" : "T3 UI";
  return `❌ 已拒绝（${source}）`;
}

function formatApprovalPrompt(approval: WagentPendingApproval): string {
  const command =
    approval.command.length > 1500 ? `${approval.command.slice(0, 1500)}…` : approval.command;
  return `⚠️ 删除确认（${approval.reason}）\n\n${command}\n\n可在 Telegram 或 T3 Code /wagent 页面确认；超时将自动拒绝。`;
}

export class TelegramChannel {
  readonly #tg: TelegramPort;
  readonly #runtime: TelegramChannelRuntimePort;
  readonly #approvalHub: ApprovalHub;
  readonly #pollTimeoutSec: number;
  readonly #knownChatIds = new Set<number>();
  readonly #approvalMessages = new Map<string, Array<{ chatId: number; messageId: number }>>();
  readonly #runChatIds = new Map<string, number>();
  #abortController: AbortController | null = null;
  #unsubscribeApproval: (() => void) | null = null;
  #pollLoopPromise: Promise<void> | null = null;
  #running = false;
  #offset = 0;

  constructor(options: {
    readonly telegram: TelegramPort;
    readonly runtime: TelegramChannelRuntimePort;
    readonly approvalHub: ApprovalHub;
    readonly pollTimeoutSec?: number;
  }) {
    this.#tg = options.telegram;
    this.#runtime = options.runtime;
    this.#approvalHub = options.approvalHub;
    this.#pollTimeoutSec = options.pollTimeoutSec ?? 25;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#abortController = new AbortController();
    this.#unsubscribeApproval = this.#approvalHub.subscribe((event) => {
      void this.#handleApprovalEvent(event);
    });
    this.#pollLoopPromise = this.#runPollLoop(this.#abortController.signal);
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#unsubscribeApproval?.();
    this.#unsubscribeApproval = null;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#pollLoopPromise) {
      await this.#pollLoopPromise.catch(() => undefined);
      this.#pollLoopPromise = null;
    }
    this.#approvalMessages.clear();
    this.#runChatIds.clear();
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.#handleCallbackQuery(update.callback_query);
      return;
    }
    if (update.message) {
      await this.#handleMessage(update.message);
    }
  }

  async #runPollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#running) {
      try {
        const updates = await this.#tg.getUpdates(this.#offset, this.#pollTimeoutSec, signal);
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          await this.processUpdate(update);
        }
      } catch {
        if (signal.aborted || !this.#running) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  async #handleApprovalEvent(event: ApprovalHubEvent): Promise<void> {
    if (event.type === "approval_requested") {
      const targets = this.#resolveNotificationChats(event.approval.runId);
      if (targets.length === 0) return;
      const sent: Array<{ chatId: number; messageId: number }> = [];
      for (const chatId of targets) {
        try {
          const message = await this.#tg.sendMessage(chatId, formatApprovalPrompt(event.approval), {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 允许", callback_data: `ok:${event.approval.id}` },
                  { text: "❌ 拒绝", callback_data: `no:${event.approval.id}` },
                ],
              ],
            },
          });
          sent.push({ chatId, messageId: message.message_id });
        } catch {
          // Best-effort delivery to paired Telegram chats.
        }
      }
      if (sent.length > 0) {
        this.#approvalMessages.set(event.approval.id, sent);
      }
      return;
    }

    const targets = this.#approvalMessages.get(event.approval.id);
    if (!targets) return;
    this.#approvalMessages.delete(event.approval.id);
    const label = formatDecisionLabel(event.approval);
    const command =
      event.approval.command.length > 1500
        ? `${event.approval.command.slice(0, 1500)}…`
        : event.approval.command;
    const text = `${label}（${event.approval.reason}）\n\n${command}`;
    for (const target of targets) {
      try {
        await this.#tg.editMessageText(target.chatId, target.messageId, text, {
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // Message may already be deleted or unchanged.
      }
    }
  }

  #resolveNotificationChats(runId: string): ReadonlyArray<number> {
    const runChat = this.#runChatIds.get(runId);
    if (runChat !== undefined) return [runChat];
    const allowed = this.#runtime.getAllowedUserIds();
    const chats = new Set<number>();
    for (const chatId of this.#knownChatIds) {
      if (allowed.includes(chatId)) chats.add(chatId);
    }
    if (chats.size === 0) {
      for (const userId of allowed) {
        chats.add(userId);
      }
    }
    return [...chats];
  }

  async #handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const allowed = this.#runtime.getAllowedUserIds();
    if (!allowed.includes(query.from.id)) {
      await this.#tg.answerCallbackQuery(query.id, "无权限").catch(() => undefined);
      return;
    }
    const data = query.data ?? "";
    const match = /^(ok|no):(.+)$/.exec(data);
    if (!match) {
      await this.#tg.answerCallbackQuery(query.id).catch(() => undefined);
      return;
    }
    const allow = match[1] === "ok";
    const approvalId = match[2]!;
    const resolved = this.#approvalHub.tryDecide(approvalId, allow, "telegram");
    if (!resolved) {
      await this.#tg.answerCallbackQuery(query.id, "该确认已处理或超时").catch(() => undefined);
      return;
    }
    await this.#tg
      .answerCallbackQuery(query.id, allow ? "已允许" : "已拒绝")
      .catch(() => undefined);
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    const userId = message.from?.id;
    const chatId = message.chat.id;
    if (!userId) return;

    const allowed = this.#runtime.getAllowedUserIds();
    if (allowed.length === 0) {
      await this.#tg.sendMessage(
        chatId,
        `你的 Telegram ID 是 ${userId}。请先在 T3 Code 的 Wagent 设置中将其加入允许列表。`,
      );
      return;
    }
    if (!allowed.includes(userId)) {
      await this.#tg.sendMessage(chatId, `未授权用户（ID: ${userId}）。`);
      return;
    }
    this.#knownChatIds.add(chatId);

    const text = (message.text ?? message.caption ?? "").trim();
    if (text === "/start" || text === "/help") {
      await this.#tg.sendMessage(
        chatId,
        [
          "Wagent 已连接（由 T3 Code 调度托管）。",
          "/new: 开启新会话",
          "/stop: 中止当前任务",
          "/status: 查看当前状态",
          "所有删除类命令需在 Telegram 或 T3 Code /wagent 确认。",
        ].join("\n"),
      );
      return;
    }
    if (text === "/status") {
      await this.#tg.sendMessage(chatId, this.#runtime.getSummaryStatus());
      return;
    }
    if (text === "/stop") {
      const aborted = await this.#runtime.abortActive();
      await this.#tg.sendMessage(
        chatId,
        aborted ? "已请求中止当前任务。" : "当前没有运行中的任务。",
      );
      return;
    }
    if (text === "/new") {
      try {
        await this.#runtime.resetSession();
        await this.#tg.sendMessage(chatId, "已开启新的 Wagent 会话。");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `无法重置会话：${reason}`);
      }
      return;
    }

    const promptParts: string[] = [];
    if (message.document) {
      try {
        const savedPath = await this.#tg.downloadFile(
          message.document.file_id,
          this.#runtime.getInboxDir(),
          message.document.file_name,
        );
        promptParts.push(`[用户发送了文件，已保存到 ${savedPath}]`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `下载文件失败：${reason}`);
        return;
      }
    } else if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      try {
        const savedPath = await this.#tg.downloadFile(
          largest.file_id,
          this.#runtime.getInboxDir(),
          `photo_${NodePath.basename(largest.file_id)}.jpg`,
        );
        promptParts.push(`[用户发送了图片，已保存到 ${savedPath}]`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `下载图片失败：${reason}`);
        return;
      }
    }
    if (text) {
      promptParts.push(text);
    }
    const finalPrompt = promptParts.join("\n").trim();
    if (!finalPrompt) return;

    const statusMsg = await this.#tg.sendMessage(chatId, "思考中…");
    try {
      await this.#tg.sendChatAction(chatId, "typing").catch(() => undefined);
      const run = await this.#runtime.dispatchFromTelegram({
        prompt: finalPrompt,
        chatId,
        onFile: async (filePath, caption) => {
          await this.#tg.sendDocument(chatId, filePath, caption);
        },
      });
      this.#runChatIds.set(run.id, chatId);
      const reply =
        run.status === "failed"
          ? `执行失败：${run.error ?? "未知错误"}`
          : run.status === "cancelled"
            ? "任务已中止。"
            : run.output.trim() || "(完成，无文本输出)";
      await this.#tg.deleteMessage(chatId, statusMsg.message_id).catch(() => undefined);
      for (const part of chunks(reply)) {
        await this.#tg.sendMessage(chatId, part);
      }
      this.#runChatIds.delete(run.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.#tg
        .editMessageText(chatId, statusMsg.message_id, `出错：${reason}`)
        .catch(() => undefined);
    }
  }
}
