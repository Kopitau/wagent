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

export interface TelegramEnqueuedRun {
  readonly runId: string;
  readonly completed: Promise<WagentRunRecord>;
}

export interface TelegramChannelRuntimePort {
  readonly getAllowedUserIds: () => ReadonlyArray<number>;
  readonly getInboxDir: () => string;
  readonly getSummaryStatus: () => string;
  readonly dispatchFromTelegram: (input: {
    readonly prompt: string;
    readonly chatId: number;
    readonly onFile?: (filePath: string, caption?: string) => Promise<void>;
  }) => TelegramEnqueuedRun | Promise<TelegramEnqueuedRun>;
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
  readonly #knownUserChats = new Map<number, number>();
  readonly #approvalMessages = new Map<
    string,
    Array<{ userId: number; chatId: number; messageId: number }>
  >();
  readonly #runOwners = new Map<string, { readonly userId: number; readonly chatId: number }>();
  readonly #inflightDeliveries = new Set<Promise<void>>();
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

  async stop(options?: { readonly waitForDeliveries?: boolean }): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#unsubscribeApproval?.();
    this.#unsubscribeApproval = null;
    this.#abortController?.abort();
    if (this.#pollLoopPromise) {
      await this.#pollLoopPromise.catch(() => undefined);
      this.#pollLoopPromise = null;
    }
    if (options?.waitForDeliveries === true) {
      await Promise.allSettled(this.#inflightDeliveries);
    }
    this.#inflightDeliveries.clear();
    this.#approvalMessages.clear();
    this.#runOwners.clear();
  }

  #isUserAllowed(userId: number): boolean {
    return this.#running && this.#runtime.getAllowedUserIds().includes(userId);
  }

  async processUpdate(update: TelegramUpdate, signal?: AbortSignal): Promise<void> {
    const effectiveSignal = signal ?? this.#abortController?.signal;
    if (effectiveSignal?.aborted || !this.#running) return;
    if (update.callback_query) {
      await this.#handleCallbackQuery(update.callback_query, effectiveSignal);
      return;
    }
    if (update.message) {
      await this.#handleMessage(update.message, effectiveSignal);
    }
  }

  async #runPollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#running) {
      try {
        const updates = await this.#tg.getUpdates(this.#offset, this.#pollTimeoutSec, signal);
        for (const update of updates) {
          if (signal.aborted || !this.#running) break;
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          await this.processUpdate(update, signal);
        }
      } catch {
        if (signal.aborted || !this.#running) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  async #handleApprovalEvent(event: ApprovalHubEvent): Promise<void> {
    const signal = this.#abortController?.signal;
    if (event.type === "approval_requested") {
      const targets = this.#resolveNotificationTargets(event.approval.runId);
      if (targets.length === 0) return;
      const sent: Array<{ userId: number; chatId: number; messageId: number }> = [];
      for (const target of targets) {
        if (!this.#isUserAllowed(target.userId)) continue;
        try {
          const message = await this.#tg.sendMessage(
            target.chatId,
            formatApprovalPrompt(event.approval),
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ 允许", callback_data: `ok:${event.approval.id}` },
                    { text: "❌ 拒绝", callback_data: `no:${event.approval.id}` },
                  ],
                ],
              },
            },
            signal,
          );
          sent.push({
            userId: target.userId,
            chatId: target.chatId,
            messageId: message.message_id,
          });
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
      if (!this.#isUserAllowed(target.userId)) continue;
      try {
        await this.#tg.editMessageText(
          target.chatId,
          target.messageId,
          text,
          {
            reply_markup: { inline_keyboard: [] },
          },
          signal,
        );
      } catch {
        // Message may already be deleted or unchanged.
      }
    }
  }

  #resolveNotificationTargets(
    runId: string,
  ): ReadonlyArray<{ readonly userId: number; readonly chatId: number }> {
    const runOwner = this.#runOwners.get(runId);
    if (runOwner !== undefined) {
      return this.#isUserAllowed(runOwner.userId) ? [runOwner] : [];
    }
    const allowed = this.#runtime.getAllowedUserIds();
    const targets: Array<{ readonly userId: number; readonly chatId: number }> = [];
    for (const userId of allowed) {
      targets.push({ userId, chatId: this.#knownUserChats.get(userId) ?? userId });
    }
    return targets;
  }

  async #handleCallbackQuery(
    query: TelegramCallbackQuery,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    const signal = callerSignal ?? this.#abortController?.signal;
    if (signal?.aborted || !this.#running) return;
    const allowed = this.#runtime.getAllowedUserIds();
    if (!allowed.includes(query.from.id)) {
      await this.#tg.answerCallbackQuery(query.id, "无权限", signal).catch(() => undefined);
      return;
    }
    const data = query.data ?? "";
    const match = /^(ok|no):(.+)$/.exec(data);
    if (!match) {
      await this.#tg.answerCallbackQuery(query.id, undefined, signal).catch(() => undefined);
      return;
    }
    const allow = match[1] === "ok";
    const approvalId = match[2]!;
    const resolved = this.#approvalHub.tryDecide(approvalId, allow, "telegram");
    if (!resolved) {
      await this.#tg
        .answerCallbackQuery(query.id, "该确认已处理或超时", signal)
        .catch(() => undefined);
      return;
    }
    await this.#tg
      .answerCallbackQuery(query.id, allow ? "已允许" : "已拒绝", signal)
      .catch(() => undefined);
  }

  async #handleMessage(message: TelegramMessage, callerSignal?: AbortSignal): Promise<void> {
    const userId = message.from?.id;
    const chatId = message.chat.id;
    if (!userId) return;
    const signal = callerSignal ?? this.#abortController?.signal;
    if (signal?.aborted || !this.#running) return;

    const allowed = this.#runtime.getAllowedUserIds();
    if (allowed.length === 0) {
      await this.#tg.sendMessage(
        chatId,
        `你的 Telegram ID 是 ${userId}。请先在 T3 Code 的 Wagent 设置中将其加入允许列表。`,
        undefined,
        signal,
      );
      return;
    }
    if (!allowed.includes(userId)) {
      await this.#tg.sendMessage(chatId, `未授权用户（ID: ${userId}）。`, undefined, signal);
      return;
    }
    this.#knownUserChats.set(userId, chatId);

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
        undefined,
        signal,
      );
      return;
    }
    if (text === "/status") {
      await this.#tg.sendMessage(chatId, this.#runtime.getSummaryStatus(), undefined, signal);
      return;
    }
    if (text === "/stop") {
      const aborted = await this.#runtime.abortActive();
      await this.#tg.sendMessage(
        chatId,
        aborted ? "已请求中止当前任务。" : "当前没有运行中的任务。",
        undefined,
        signal,
      );
      return;
    }
    if (text === "/new") {
      try {
        await this.#runtime.resetSession();
        await this.#tg.sendMessage(chatId, "已开启新的 Wagent 会话。", undefined, signal);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `无法重置会话：${reason}`, undefined, signal);
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
          signal,
        );
        promptParts.push(`[用户发送了文件，已保存到 ${savedPath}]`);
      } catch (error) {
        if (signal?.aborted || !this.#isUserAllowed(userId)) return;
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `下载文件失败：${reason}`, undefined, signal);
        return;
      }
    } else if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      try {
        const savedPath = await this.#tg.downloadFile(
          largest.file_id,
          this.#runtime.getInboxDir(),
          `photo_${NodePath.basename(largest.file_id)}.jpg`,
          signal,
        );
        promptParts.push(`[用户发送了图片，已保存到 ${savedPath}]`);
      } catch (error) {
        if (signal?.aborted || !this.#isUserAllowed(userId)) return;
        const reason = error instanceof Error ? error.message : String(error);
        await this.#tg.sendMessage(chatId, `下载图片失败：${reason}`, undefined, signal);
        return;
      }
    }
    if (text) {
      promptParts.push(text);
    }
    const finalPrompt = promptParts.join("\n").trim();
    if (!finalPrompt || !this.#isUserAllowed(userId)) return;

    const statusMsg = await this.#tg.sendMessage(chatId, "思考中…", undefined, signal);
    try {
      await this.#tg.sendChatAction(chatId, "typing", signal).catch(() => undefined);
      if (!this.#isUserAllowed(userId) || signal?.aborted) {
        return;
      }
      const enqueued = await this.#runtime.dispatchFromTelegram({
        prompt: finalPrompt,
        chatId,
        onFile: async (filePath, caption) => {
          if (!this.#isUserAllowed(userId)) {
            return;
          }
          await this.#tg.sendDocument(
            chatId,
            filePath,
            caption,
            this.#abortController?.signal,
            () => this.#isUserAllowed(userId),
          );
        },
      });
      this.#runOwners.set(enqueued.runId, { userId, chatId });
      const delivery = this.#deliverRunCompletion(
        userId,
        chatId,
        statusMsg.message_id,
        enqueued.runId,
        enqueued.completed,
      ).finally(() => {
        this.#inflightDeliveries.delete(delivery);
      });
      this.#inflightDeliveries.add(delivery);
    } catch (error) {
      if (!this.#isUserAllowed(userId)) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#tg
        .editMessageText(chatId, statusMsg.message_id, `出错：${reason}`, undefined, signal)
        .catch(() => undefined);
    }
  }

  async #deliverRunCompletion(
    userId: number,
    chatId: number,
    statusMessageId: number,
    runId: string,
    completed: Promise<WagentRunRecord>,
  ): Promise<void> {
    try {
      const run = await completed;
      if (!this.#isUserAllowed(userId)) return;
      const signal = this.#abortController?.signal;
      const reply =
        run.status === "failed"
          ? `执行失败：${run.error ?? "未知错误"}`
          : run.status === "cancelled"
            ? "任务已中止。"
            : run.output.trim() || "(完成，无文本输出)";
      await this.#tg.deleteMessage(chatId, statusMessageId, signal).catch(() => undefined);
      for (const part of chunks(reply)) {
        if (!this.#isUserAllowed(userId) || signal?.aborted) return;
        await this.#tg.sendMessage(chatId, part, undefined, signal);
      }
    } catch (error) {
      if (!this.#isUserAllowed(userId)) return;
      const signal = this.#abortController?.signal;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#tg
        .editMessageText(chatId, statusMessageId, `出错：${reason}`, undefined, signal)
        .catch(() => undefined);
    } finally {
      this.#runOwners.delete(runId);
    }
  }
}
