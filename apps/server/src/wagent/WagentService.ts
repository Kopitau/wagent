import {
  type WagentAbortInput,
  type WagentAbortResult,
  WagentApprovalNotFoundError,
  type WagentConfigView,
  type WagentConvertToDocInput,
  type WagentConvertToDocResult,
  type WagentDecideApprovalInput,
  type WagentDecideApprovalResult,
  type WagentDispatchSource,
  type WagentEvent,
  WagentExportNotFoundError,
  type WagentImportExportToLibraryInput,
  type WagentImportExportToLibraryResult,
  type WagentNewSessionResult,
  type WagentRpcError,
  WagentRuntimeError,
  type WagentSendInput,
  type WagentSendResult,
  type WagentStatusResult,
  WagentUnavailableError,
  type WagentUpdateConfigInput,
  type WagentUpdateConfigResult,
  WagentValidationError,
} from "@t3tools/contracts";
import {
  TelegramChannel,
  TelegramClient,
  WagentBridgeError,
  WagentRuntime,
  type TelegramPort,
  type WagentBridgeEvent,
  type WagentExecutor,
  type WagentSecrets,
} from "@t3tools/wagent-bridge";
import { WkbBridgeError, type runWkbExport } from "@t3tools/wkb-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as LibraryService from "../library/LibraryService.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";

const SECRET_TELEGRAM_BOT_TOKEN = "wagent-telegram-bot-token";
const SECRET_DEEPSEEK_API_KEY = "wagent-deepseek-api-key";
const SECRET_WKB_TOKEN = "wagent-wkb-token";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface WagentServiceTestOverrides {
  readonly executor?: WagentExecutor | undefined;
  readonly telegramFactory?: ((token: string) => TelegramPort) | undefined;
  readonly approvalTimeoutOverrideMs?: number | undefined;
  readonly wkbExportImpl?: typeof runWkbExport | undefined;
}

function mapWagentError(
  error: unknown,
  context?: { readonly approvalId?: string; readonly relativePath?: string },
): WagentRpcError {
  if (error instanceof WagentBridgeError) {
    switch (error.code) {
      case "validation":
        return new WagentValidationError({
          reason: error.message.slice(0, 400) || "Invalid input.",
        });
      case "unavailable":
        return new WagentUnavailableError({
          reason: error.message.slice(0, 400) || "Wagent runtime is unavailable.",
        });
      case "approval_not_found":
        return new WagentApprovalNotFoundError({
          approvalId: context?.approvalId ?? "unknown",
        });
      case "export_not_found":
        return new WagentExportNotFoundError({
          relativePath: context?.relativePath ?? "unknown",
        });
      case "aborted":
      case "runtime_failed":
        return new WagentRuntimeError({
          reason: error.message.slice(0, 400) || "Wagent operation failed.",
        });
    }
  }
  if (error instanceof WkbBridgeError) {
    if (error.code === "unavailable") {
      return new WagentUnavailableError({ reason: error.message.slice(0, 400) });
    }
    if (error.code === "invalid_source") {
      return new WagentValidationError({ reason: error.message.slice(0, 400) });
    }
    return new WagentRuntimeError({ reason: error.message.slice(0, 400) });
  }
  const message =
    error instanceof Error && error.message ? error.message : String(error ?? "Wagent error");
  return new WagentRuntimeError({ reason: message.slice(0, 400) });
}

export class WagentService extends Context.Service<
  WagentService,
  {
    readonly status: Effect.Effect<WagentStatusResult, WagentRpcError>;
    readonly send: (
      input: WagentSendInput,
      options?: {
        readonly source?: WagentDispatchSource | undefined;
        readonly awaitCompletion?: boolean | undefined;
      },
    ) => Effect.Effect<WagentSendResult, WagentRpcError>;
    readonly abort: (input: WagentAbortInput) => Effect.Effect<WagentAbortResult, WagentRpcError>;
    readonly newSession: Effect.Effect<WagentNewSessionResult, WagentRpcError>;
    readonly decideApproval: (
      input: WagentDecideApprovalInput,
    ) => Effect.Effect<WagentDecideApprovalResult, WagentRpcError>;
    readonly importExportToLibrary: (
      input: WagentImportExportToLibraryInput,
    ) => Effect.Effect<WagentImportExportToLibraryResult, WagentRpcError>;
    readonly convertToDoc: (
      input: WagentConvertToDocInput,
    ) => Effect.Effect<WagentConvertToDocResult, WagentRpcError>;
    readonly updateConfig: (
      input: WagentUpdateConfigInput,
    ) => Effect.Effect<WagentUpdateConfigResult, WagentRpcError>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<WagentEvent>, never, Scope.Scope>;
  }
>()("t3/wagent/WagentService") {}

export const eventsStream = (
  service: WagentService["Service"],
): Stream.Stream<WagentEvent, WagentRpcError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const initial: WagentEvent = { type: "snapshot", status: yield* service.status };
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);

const make = Effect.fn("WagentService.make")(function* (overrides?: WagentServiceTestOverrides) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const library = yield* LibraryService.LibraryService;
  const wkbBridge = yield* WkbBridgeService.WkbBridgeService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const cwd = yield* HostProcess.WorkingDirectory;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const wagentStateDir = path.join(serverConfig.stateDir, "wagent");
  yield* fs.makeDirectory(wagentStateDir, { recursive: true }).pipe(Effect.orDie);

  const wkbStatus = yield* wkbBridge.status;
  const defaultKbDir = wkbStatus.kbDir ?? path.join(homeDir, "kb");

  const agentDirCandidates = [
    env.T3CODE_WAGENT_AGENT_DIR,
    path.resolve(cwd, "..", "agent"),
    path.resolve(cwd, "agent"),
    path.join(homeDir, "Wagent", "agent"),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  let defaultAgentDir = path.join(homeDir, "Wagent-agent");
  for (const candidate of agentDirCandidates) {
    const hasPkg = yield* fs
      .exists(path.join(candidate, "package.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasPkg) {
      defaultAgentDir = candidate;
      break;
    }
  }

  const readSecretString = (name: string) =>
    secretStore.get(name).pipe(
      Effect.map(
        Option.match({
          onNone: () => undefined as string | undefined,
          onSome: (bytes) => {
            const decoded = textDecoder.decode(bytes).trim();
            return decoded.length > 0 ? decoded : undefined;
          },
        }),
      ),
      Effect.orElseSucceed(() => undefined as string | undefined),
    );

  const writeOptionalSecret = (name: string, value: string | null | undefined) => {
    if (value === undefined) return Effect.void;
    const trimmed = value === null ? "" : value.trim();
    if (!trimmed) {
      return secretStore.remove(name).pipe(
        Effect.mapError(
          (cause) =>
            new WagentRuntimeError({
              reason: `Failed to clear secret '${name}': ${cause.message}`.slice(0, 400),
            }),
        ),
      );
    }
    return secretStore.set(name, textEncoder.encode(trimmed)).pipe(
      Effect.mapError(
        (cause) =>
          new WagentRuntimeError({
            reason: `Failed to store secret '${name}': ${cause.message}`.slice(0, 400),
          }),
      ),
    );
  };

  const readSecretsEffect: Effect.Effect<WagentSecrets> = Effect.gen(function* () {
    const telegramBotToken = yield* readSecretString(SECRET_TELEGRAM_BOT_TOKEN);
    const deepseekApiKey = yield* readSecretString(SECRET_DEEPSEEK_API_KEY);
    const wkbToken = yield* readSecretString(SECRET_WKB_TOKEN);
    return {
      ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
      ...(deepseekApiKey !== undefined ? { deepseekApiKey } : {}),
      ...(wkbToken !== undefined ? { wkbToken } : {}),
    };
  });

  const eventsPubSub = yield* PubSub.unbounded<WagentEvent>();
  const channelLock = yield* Semaphore.make(1);
  let telegramChannel: TelegramChannel | null = null;
  let activeTelegramToken: string | null = null;

  const runtime = new WagentRuntime({
    stateDir: wagentStateDir,
    homeDir,
    defaultKbDir,
    defaultAgentDir,
    getSecrets: () => runPromise(readSecretsEffect),
    executor: overrides?.executor,
    approvalTimeoutOverrideMs: overrides?.approvalTimeoutOverrideMs,
    wkbExportImpl: overrides?.wkbExportImpl,
  });

  const buildStatus = Effect.fn("WagentService.buildStatus")(function* () {
    const secrets = yield* readSecretsEffect;
    const snapshot = yield* Effect.tryPromise({
      try: () => runtime.getSnapshot(),
      catch: (error) => mapWagentError(error),
    });
    const configView: WagentConfigView = {
      workspace: snapshot.config.workspace,
      model: { ...snapshot.config.model },
      kbUrl: snapshot.config.kbUrl,
      kbDir: snapshot.config.kbDir,
      confirmTimeoutSec: snapshot.config.confirmTimeoutSec,
      telegramEnabled: snapshot.config.telegramEnabled,
      allowedUserIds: [...snapshot.config.allowedUserIds],
      proxy: snapshot.config.proxy,
      agentDir: snapshot.config.agentDir,
      hasTelegramBotToken: Boolean(secrets.telegramBotToken),
      hasDeepseekApiKey: Boolean(secrets.deepseekApiKey),
      hasWkbToken: Boolean(secrets.wkbToken),
    };
    return {
      running: snapshot.running,
      sessionId: snapshot.sessionId,
      activeRun: snapshot.activeRun
        ? { ...snapshot.activeRun, steps: [...snapshot.activeRun.steps] }
        : null,
      queuedRuns: snapshot.queuedRuns.map((run) => ({ ...run, steps: [...run.steps] })),
      recentRuns: snapshot.recentRuns.map((run) => ({ ...run, steps: [...run.steps] })),
      pendingApprovals: [...snapshot.pendingApprovals],
      exports: [...snapshot.exports],
      config: configView,
      telegramConnected: Boolean(telegramChannel?.isRunning),
      agentDirReady: snapshot.agentDirReady,
      kbDirReady: snapshot.kbDirReady,
    } satisfies WagentStatusResult;
  });

  const syncTelegramChannel = channelLock.withPermits(1)(
    Effect.gen(function* () {
      const secrets = yield* readSecretsEffect;
      const shouldRun = runtime.config.telegramEnabled && Boolean(secrets.telegramBotToken);
      const desiredToken = shouldRun ? (secrets.telegramBotToken ?? null) : null;

      if (!shouldRun || !desiredToken) {
        if (telegramChannel) {
          const existing = telegramChannel;
          telegramChannel = null;
          activeTelegramToken = null;
          yield* Effect.promise(() => existing.stop());
        }
        return;
      }

      if (telegramChannel?.isRunning && activeTelegramToken === desiredToken) {
        return;
      }

      if (telegramChannel) {
        const existing = telegramChannel;
        telegramChannel = null;
        activeTelegramToken = null;
        yield* Effect.promise(() => existing.stop());
      }

      const telegramPort = overrides?.telegramFactory
        ? overrides.telegramFactory(desiredToken)
        : new TelegramClient(desiredToken);

      const nextChannel = new TelegramChannel({
        telegram: telegramPort,
        approvalHub: runtime.approvalHub,
        runtime: {
          getAllowedUserIds: () => runtime.config.allowedUserIds,
          getInboxDir: () => runtime.inboxDir,
          getSummaryStatus: () => {
            const pendingCount = runtime.approvalHub.listPending().length;
            return `模型: ${runtime.config.model.provider}/${runtime.config.model.id}\n工作区: ${runtime.config.workspace}\n待确认删除: ${pendingCount}`;
          },
          dispatchFromTelegram: async ({ prompt, onFile }) => {
            const queued = runtime.enqueue({ prompt, source: "telegram", onFile });
            return queued.completed;
          },
          abortActive: () => runtime.abort(),
          resetSession: async () => {
            await runtime.newSession();
          },
        },
      });
      nextChannel.start();
      telegramChannel = nextChannel;
      activeTelegramToken = desiredToken;
    }),
  );

  const publishEvent = (event: WagentEvent) => {
    void runPromise(PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid)).catch(() => undefined);
  };

  const handleBridgeEvent = (event: WagentBridgeEvent) => {
    if (event.type === "status_changed") {
      void runPromise(
        buildStatus().pipe(
          Effect.flatMap((nextStatus) =>
            PubSub.publish(eventsPubSub, { type: "status_changed", status: nextStatus }),
          ),
          Effect.ignore,
        ),
      );
      return;
    }
    if (event.type === "run_started" || event.type === "run_finished") {
      publishEvent({
        type: event.type,
        run: { ...event.run, steps: [...event.run.steps] },
      });
      return;
    }
    publishEvent(event);
  };

  const unsubscribeRuntime = runtime.subscribe(handleBridgeEvent);

  yield* Effect.acquireRelease(syncTelegramChannel, () =>
    Effect.gen(function* () {
      unsubscribeRuntime();
      if (telegramChannel) {
        const existing = telegramChannel;
        telegramChannel = null;
        activeTelegramToken = null;
        yield* Effect.promise(() => existing.stop()).pipe(Effect.ignore);
      }
      yield* Effect.promise(() => runtime.dispose()).pipe(Effect.ignore);
    }),
  );

  const status: WagentService["Service"]["status"] = buildStatus();

  const send: WagentService["Service"]["send"] = Effect.fn("WagentService.send")(
    function* (input, options) {
      const queued = yield* Effect.try({
        try: () =>
          runtime.enqueue({
            prompt: input.prompt,
            source: options?.source ?? "ui",
          }),
        catch: (error) => mapWagentError(error),
      });

      if (options?.awaitCompletion) {
        const finished = yield* Effect.tryPromise({
          try: () => queued.completed,
          catch: (error) => mapWagentError(error),
        });
        return { run: { ...finished, steps: [...finished.steps] } };
      }
      return { run: { ...queued.run, steps: [...queued.run.steps] } };
    },
  );

  const abort: WagentService["Service"]["abort"] = Effect.fn("WagentService.abort")(
    function* (input) {
      const aborted = yield* Effect.tryPromise({
        try: () => runtime.abort(input.runId),
        catch: (error) => mapWagentError(error),
      });
      return { aborted };
    },
  );

  const newSession: WagentService["Service"]["newSession"] = Effect.tryPromise({
    try: () => runtime.newSession(),
    catch: (error) => mapWagentError(error),
  }).pipe(
    Effect.map((sessionId) => ({ sessionId })),
    Effect.withSpan("WagentService.newSession"),
  );

  const decideApproval: WagentService["Service"]["decideApproval"] = Effect.fn(
    "WagentService.decideApproval",
  )(function* (input) {
    const approval = yield* Effect.try({
      try: () => runtime.decideApproval(input.approvalId, input.allow, "ui"),
      catch: (error) => mapWagentError(error, { approvalId: input.approvalId }),
    });
    return { approval };
  });

  const importExportToLibrary: WagentService["Service"]["importExportToLibrary"] = Effect.fn(
    "WagentService.importExportToLibrary",
  )(function* (input) {
    const resolved = yield* Effect.tryPromise({
      try: () => runtime.resolveExportFile(input.relativePath),
      catch: (error) => mapWagentError(error, { relativePath: input.relativePath }),
    });

    const tags = input.tags && input.tags.length > 0 ? [...input.tags] : ["wagent"];

    if (resolved.file.kind === "pdf") {
      const bytes = yield* fs.readFile(resolved.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WagentRuntimeError({
              reason:
                `Failed to read exported PDF '${resolved.file.relativePath}': ${cause.message}`.slice(
                  0,
                  400,
                ),
            }),
        ),
      );
      const entry = yield* library
        .uploadPdfStream({
          fileName: resolved.file.name,
          chunks: (async function* () {
            yield Uint8Array.from(bytes);
          })(),
          ...(input.title === undefined ? {} : { title: input.title }),
          tags,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new WagentRuntimeError({
                reason: `Failed to import PDF into Research Library: ${error.message}`.slice(
                  0,
                  400,
                ),
              }),
          ),
        );
      return { entry, exportFile: resolved.file };
    }

    if (resolved.file.kind === "markdown" || resolved.file.kind === "text") {
      const content = yield* fs.readFileString(resolved.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WagentRuntimeError({
              reason:
                `Failed to read exported document '${resolved.file.relativePath}': ${cause.message}`.slice(
                  0,
                  400,
                ),
            }),
        ),
      );
      const entry = yield* library
        .importTextFile({
          fileName: resolved.file.name,
          content,
          ...(input.title === undefined ? {} : { title: input.title }),
          tags,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new WagentRuntimeError({
                reason: `Failed to import document into Research Library: ${error.message}`.slice(
                  0,
                  400,
                ),
              }),
          ),
        );
      return { entry, exportFile: resolved.file };
    }

    return yield* new WagentValidationError({
      reason: `Export '${resolved.file.name}' is not a PDF, Markdown, or plain-text file.`,
    });
  });

  const convertToDoc: WagentService["Service"]["convertToDoc"] = Effect.fn(
    "WagentService.convertToDoc",
  )(function* (input) {
    const converted = yield* Effect.tryPromise({
      try: () =>
        runtime.convertToDoc({
          source: input.source,
          pdf: input.pdf,
        }),
      catch: (error) => mapWagentError(error),
    });
    return {
      title: converted.result.title,
      inferredKind: converted.result.inferredKind,
      warnings: [...converted.result.warnings],
      savedFiles: [...converted.savedFiles],
    };
  });

  const updateConfig: WagentService["Service"]["updateConfig"] = Effect.fn(
    "WagentService.updateConfig",
  )(function* (input) {
    yield* writeOptionalSecret(SECRET_TELEGRAM_BOT_TOKEN, input.telegramBotToken);
    yield* writeOptionalSecret(SECRET_DEEPSEEK_API_KEY, input.deepseekApiKey);
    yield* writeOptionalSecret(SECRET_WKB_TOKEN, input.wkbToken);

    yield* Effect.tryPromise({
      try: () =>
        runtime.updateConfig({
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.model !== undefined
            ? {
                model: {
                  ...(input.model.provider !== undefined ? { provider: input.model.provider } : {}),
                  ...(input.model.id !== undefined ? { id: input.model.id } : {}),
                  ...(input.model.thinking !== undefined ? { thinking: input.model.thinking } : {}),
                },
              }
            : {}),
          ...(input.kbUrl !== undefined ? { kbUrl: input.kbUrl } : {}),
          ...(input.kbDir !== undefined ? { kbDir: input.kbDir } : {}),
          ...(input.confirmTimeoutSec !== undefined
            ? { confirmTimeoutSec: input.confirmTimeoutSec }
            : {}),
          ...(input.telegramEnabled !== undefined
            ? { telegramEnabled: input.telegramEnabled }
            : {}),
          ...(input.allowedUserIds !== undefined ? { allowedUserIds: input.allowedUserIds } : {}),
          ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
          ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}),
        }),
      catch: (error) => mapWagentError(error),
    });

    yield* syncTelegramChannel;
    const nextStatus = yield* buildStatus();
    yield* PubSub.publish(eventsPubSub, { type: "status_changed", status: nextStatus });
    return { status: nextStatus };
  });

  return WagentService.of({
    status,
    send,
    abort,
    newSession,
    decideApproval,
    importExportToLibrary,
    convertToDoc,
    updateConfig,
    subscribe: PubSub.subscribe(eventsPubSub),
  });
});

export const layer = Layer.effect(WagentService, make());

export const makeLayer = (overrides?: WagentServiceTestOverrides) =>
  Layer.effect(WagentService, make(overrides));
