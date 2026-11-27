// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure non-Effect Telegram API client writes downloaded attachments to inbox.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface TelegramUser {
  readonly id: number;
  readonly username?: string | undefined;
  readonly first_name?: string | undefined;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_name?: string | undefined;
  readonly file_size?: number | undefined;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_size?: number | undefined;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser | undefined;
  readonly chat: { readonly id: number };
  readonly text?: string | undefined;
  readonly caption?: string | undefined;
  readonly document?: TelegramDocument | undefined;
  readonly photo?: ReadonlyArray<TelegramPhotoSize> | undefined;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly data?: string | undefined;
  readonly message?: TelegramMessage | undefined;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
  readonly callback_query?: TelegramCallbackQuery | undefined;
}

export type TelegramInlineKeyboard = ReadonlyArray<
  ReadonlyArray<{ readonly text: string; readonly callback_data: string }>
>;

export interface TelegramPort {
  readonly getUpdates: (
    offset: number,
    timeoutSec: number,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<TelegramUpdate>>;
  readonly sendMessage: (
    chatId: number,
    text: string,
    extra?: { readonly reply_markup?: { readonly inline_keyboard: TelegramInlineKeyboard } },
    signal?: AbortSignal,
  ) => Promise<{ readonly message_id: number }>;
  readonly editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    extra?: { readonly reply_markup?: { readonly inline_keyboard: TelegramInlineKeyboard } },
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly deleteMessage: (
    chatId: number,
    messageId: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly sendChatAction: (chatId: number, action?: string, signal?: AbortSignal) => Promise<void>;
  readonly answerCallbackQuery: (id: string, text?: string, signal?: AbortSignal) => Promise<void>;
  readonly sendDocument: (
    chatId: number,
    filePath: string,
    caption?: string,
    signal?: AbortSignal,
    shouldSend?: () => boolean,
  ) => Promise<void>;
  readonly downloadFile: (
    fileId: string,
    destDir: string,
    preferredName?: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export function chunks(text: string, max = 4000): Array<string> {
  if (!text) return ["(空)"];
  const out: Array<string> = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > i + max / 2) end = newline + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

function sanitizeFilename(name: string): string {
  const base = NodePath.basename(name).replaceAll(/[^\w.\-\u4e00-\u9fff]/g, "_");
  return base.length > 0 ? base.slice(0, 120) : "file";
}

export class TelegramClient implements TelegramPort {
  readonly #baseUrl: string;
  readonly #fileBaseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(token: string, options?: { readonly fetchImpl?: typeof fetch }) {
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
    this.#fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
    this.#fetchImpl = options?.fetchImpl ?? fetch;
  }

  async #call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetchImpl(`${this.#baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
    };
    if (!json.ok) {
      throw new Error(`Telegram ${method}: ${json.description ?? response.statusText}`);
    }
    return json.result as T;
  }

  getUpdates(
    offset: number,
    timeoutSec = 25,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<TelegramUpdate>> {
    return this.#call<ReadonlyArray<TelegramUpdate>>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    extra: { readonly reply_markup?: { readonly inline_keyboard: TelegramInlineKeyboard } } = {},
    signal?: AbortSignal,
  ): Promise<{ readonly message_id: number }> {
    return this.#call<{ readonly message_id: number }>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...extra,
      },
      signal,
    );
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    extra: { readonly reply_markup?: { readonly inline_keyboard: TelegramInlineKeyboard } } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...extra,
      },
      signal,
    );
  }

  async deleteMessage(chatId: number, messageId: number, signal?: AbortSignal): Promise<void> {
    await this.#call(
      "deleteMessage",
      {
        chat_id: chatId,
        message_id: messageId,
      },
      signal,
    );
  }

  async sendChatAction(chatId: number, action = "typing", signal?: AbortSignal): Promise<void> {
    await this.#call("sendChatAction", { chat_id: chatId, action }, signal);
  }

  async answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.#call(
      "answerCallbackQuery",
      {
        callback_query_id: id,
        ...(text ? { text } : {}),
      },
      signal,
    );
  }

  async sendDocument(
    chatId: number,
    filePath: string,
    caption?: string,
    signal?: AbortSignal,
    shouldSend?: () => boolean,
  ): Promise<void> {
    const stat = await NodeFSP.stat(filePath);
    if (stat.size > MAX_TELEGRAM_UPLOAD_BYTES) {
      throw new Error(`File exceeds Telegram 50 MiB limit (${stat.size} bytes).`);
    }
    const bytes = await NodeFSP.readFile(filePath);
    if (signal?.aborted) {
      throw new Error("Telegram sendDocument aborted.");
    }
    if (shouldSend && !shouldSend()) {
      return;
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set("document", new Blob([bytes]), NodePath.basename(filePath));
    const response = await this.#fetchImpl(`${this.#baseUrl}/sendDocument`, {
      method: "POST",
      body: form,
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram sendDocument: ${json.description ?? response.statusText}`);
    }
  }

  async downloadFile(
    fileId: string,
    destDir: string,
    preferredName?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const fileInfo = await this.#call<{ file_path?: string; file_size?: number }>(
      "getFile",
      {
        file_id: fileId,
      },
      signal,
    );
    if (!fileInfo.file_path) {
      throw new Error("Telegram getFile returned empty file_path.");
    }
    if (fileInfo.file_size && fileInfo.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      throw new Error("Telegram file exceeds 20 MiB download limit.");
    }
    const response = await this.#fetchImpl(
      `${this.#fileBaseUrl}/${fileInfo.file_path}`,
      signal ? { signal } : undefined,
    );
    if (!response.ok) {
      throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      throw new Error("Telegram file exceeds 20 MiB download limit.");
    }
    await NodeFSP.mkdir(destDir, { recursive: true });
    const safeName = sanitizeFilename(preferredName ?? NodePath.basename(fileInfo.file_path));
    const destination = NodePath.join(destDir, `${Date.now()}_${safeName}`);
    await NodeFSP.writeFile(destination, bytes);
    return destination;
  }
}
