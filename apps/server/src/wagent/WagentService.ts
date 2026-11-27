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
  sanitizeProxyUrl,
  type TelegramPort,
  type WagentBridgeEvent,
  type WagentExecutor,
  type WagentSecrets,
} from "@t3tools/wagent-bridge";
import { WkbBridgeError, canonicalizeWkbEndpointUrl, type runWkbExport } from "@t3tools/wkb-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
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
const SECRET_PROXY_URL = "wagent-proxy-url";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const BoundWkbSecretJson = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.String,
    kbUrl: Schema.String,
  }),
);
const encodeBoundWkbSecret = Schema.encodeSync(BoundWkbSecretJson);
const decodeBoundWkbSecret = Schema.decodeOption(BoundWkbSecretJson);

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
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const wagentStateDir = path.join(serverConfig.stateDir, "wagent");
  yield* fs.makeDirectory(wagentStateDir, { recursive: true }).pipe(Effect.orDie);

  const wkbStatus = yield* wkbBridge.status;
  const defaultKbDir = wkbStatus.kbDir ?? path.join(homeDir, "kb");

  // Only resolve Wagent Pi runtime from explicit admin env or trusted home root, NEVER cwd.
  const agentDirCandidates = [
    env.T3CODE_WAGENT_AGENT_DIR,
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

  const extractBoundWkbToken = (
    rawSecret: string,
    expectedKbUrl: string,
    persistedKbUrl: string | null,
  ): string | undefined => {
    const trimmed = rawSecret.trim();
    if (!trimmed) return undefined;
    const expectedNorm = canonicalizeWkbEndpointUrl(expectedKbUrl);
    if (expectedNorm === null) return undefined;
    if (trimmed.startsWith("{")) {
      const parsed = decodeBoundWkbSecret(trimmed);
      if (Option.isNone(parsed)) return undefined;
      const boundNorm = canonicalizeWkbEndpointUrl(parsed.value.kbUrl);
      if (boundNorm === null || boundNorm !== expectedNorm) {
        return undefined;
      }
      const tok = parsed.value.token.trim();
      return tok.length > 0 ? tok : undefined;
    }
    // Legacy plain-text token is ONLY valid when config.json explicitly persisted the matching kbUrl.
    const persistedNorm =
      persistedKbUrl !== null ? canonicalizeWkbEndpointUrl(persistedKbUrl) : null;
    if (persistedNorm === null || persistedNorm !== expectedNorm) {
      return undefined;
    }
    return trimmed;
  };

  let runtimeRef: WagentRuntime | null = null;

  const readSecretsForConfigEffect = Effect.fn("WagentService.readSecretsForConfig")(function* (
    targetKbUrl: string,
  ): Effect.fn.Return<WagentSecrets> {
    const telegramBotToken = yield* readSecretString(SECRET_TELEGRAM_BOT_TOKEN);
    const deepseekApiKey = yield* readSecretString(SECRET_DEEPSEEK_API_KEY);
    const rawWkbSecret = yield* readSecretString(SECRET_WKB_TOKEN);
    const wkbToken =
      rawWkbSecret !== undefined
        ? extractBoundWkbToken(rawWkbSecret, targetKbUrl, runtimeRef?.persistedKbUrl ?? null)
        : undefined;
    const proxyUrl = yield* readSecretString(SECRET_PROXY_URL);
    return {
      ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
      ...(deepseekApiKey !== undefined ? { deepseekApiKey } : {}),
      ...(wkbToken !== undefined ? { wkbToken } : {}),
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    };
  });

  const readSecretBytesStrict = (name: string) =>
    secretStore.get(name).pipe(
      Effect.mapError(
        (cause) =>
          new WagentRuntimeError({
            reason: `Failed to read secret '${name}': ${cause.message}`.slice(0, 400),
          }),
      ),
    );

  const restoreSecretBytesStrict = (name: string, previous: Option.Option<Uint8Array>) =>
    Option.match(previous, {
      onNone: () =>
        secretStore.remove(name).pipe(
          Effect.mapError(
            (cause) =>
              new WagentRuntimeError({
                reason: `Failed to roll back secret '${name}': ${cause.message}`.slice(0, 400),
              }),
          ),
        ),
      onSome: (bytes) =>
        secretStore.set(name, bytes).pipe(
          Effect.mapError(
            (cause) =>
              new WagentRuntimeError({
                reason: `Failed to restore secret '${name}': ${cause.message}`.slice(0, 400),
              }),
          ),
        ),
    });

  const eventsPubSub = yield* PubSub.unbounded<WagentEvent>();
  const channelLock = yield* Semaphore.make(1);
  const configMutationLock = yield* Semaphore.make(1);
  let telegramChannel: TelegramChannel | null = null;
  let activeTelegramToken: string | null = null;

  const runtime = new WagentRuntime({
    stateDir: wagentStateDir,
    homeDir,
    defaultKbDir,
    defaultAgentDir,
    env,
    uvBinary: wkbStatus.uvPath ?? undefined,
    getSecrets: () => runPromise(readSecretsForConfigEffect(runtime.config.kbUrl)),
    resolveExecutionContext: () =>
      runPromise(
        configMutationLock.withPermits(1)(
          Effect.gen(function* () {
            const currentConfig = runtime.config;
            const secrets = yield* readSecretsForConfigEffect(currentConfig.kbUrl);
            return {
              config: currentConfig,
              secrets:
                runtime.unmigratedLegacyProxyUrl !== null && secrets.proxyUrl === undefined
                  ? { ...secrets, proxyUrl: runtime.unmigratedLegacyProxyUrl }
                  : secrets,
            };
          }),
        ),
      ),
    executor: overrides?.executor,
    approvalTimeoutOverrideMs: overrides?.approvalTimeoutOverrideMs,
    wkbExportImpl: overrides?.wkbExportImpl,
  });
  runtimeRef = runtime;

  if (runtime.persistedKbUrl !== null) {
    const canonicalPersisted = canonicalizeWkbEndpointUrl(runtime.persistedKbUrl);
    const legacyWkbSecret = yield* readSecretString(SECRET_WKB_TOKEN);
    if (
      canonicalPersisted !== null &&
      legacyWkbSecret !== undefined &&
      !legacyWkbSecret.startsWith("{")
    ) {
      yield* writeOptionalSecret(
        SECRET_WKB_TOKEN,
        encodeBoundWkbSecret({ token: legacyWkbSecret, kbUrl: canonicalPersisted }),
      ).pipe(Effect.ignore);
    }
  }

  if (runtime.unmigratedLegacyProxyUrl !== null) {
    const legacyProxy = runtime.unmigratedLegacyProxyUrl;
    const existingProxyOpt = yield* readSecretBytesStrict(SECRET_PROXY_URL).pipe(Effect.result);
    if (existingProxyOpt._tag === "Success") {
      const migrateRes = yield* (
        Option.isNone(existingProxyOpt.success)
          ? writeOptionalSecret(SECRET_PROXY_URL, legacyProxy)
          : Effect.void
      ).pipe(Effect.result);
      if (migrateRes._tag === "Success") {
        yield* Effect.tryPromise({
          try: () => runtime.confirmLegacyProxyMigrated(),
          catch: (error) => mapWagentError(error),
        }).pipe(Effect.ignore);
      }
    }
  } else {
    yield* Effect.tryPromise({
      try: () => runtime.flushPendingConfigRewrite(),
      catch: (error) => mapWagentError(error),
    }).pipe(Effect.ignore);
  }

  const buildStatus = Effect.fn("WagentService.buildStatus")(function* () {
    const snapshot = yield* Effect.tryPromise({
      try: () => runtime.getSnapshot(),
      catch: (error) => mapWagentError(error),
    });
    const secrets = yield* readSecretsForConfigEffect(snapshot.config.kbUrl);
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
      hasProxyCredentials: Boolean(secrets.proxyUrl),
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
      const secrets = yield* readSecretsForConfigEffect(runtime.config.kbUrl);
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
          dispatchFromTelegram: ({ prompt, onFile }) => {
            const queued = runtime.enqueue({ prompt, source: "telegram", onFile });
            return { runId: queued.run.id, completed: queued.completed };
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
      yield* Effect.promise(() => runtime.dispose()).pipe(Effect.ignore);
      if (telegramChannel) {
        const existing = telegramChannel;
        telegramChannel = null;
        activeTelegramToken = null;
        yield* Effect.promise(() => existing.stop()).pipe(Effect.ignore);
      }
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
    yield* configMutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.expectedKbUrl !== undefined) {
          const expectedNorm =
            canonicalizeWkbEndpointUrl(input.expectedKbUrl) ?? input.expectedKbUrl.trim();
          const currentNorm =
            canonicalizeWkbEndpointUrl(runtime.config.kbUrl) ?? runtime.config.kbUrl.trim();
          if (expectedNorm !== currentNorm) {
            return yield* new WagentValidationError({
              reason:
                "Remote wkb MCP URL changed concurrently; reload Wagent settings before modifying the WKB token or URL.",
            });
          }
        }

        let sanitizedProxyForConfig: string | undefined;
        let nextProxySecret: string | null | undefined;

        const pendingLegacyProxy = runtime.unmigratedLegacyProxyUrl;
        let shouldConfirmLegacyProxyAfterWrite = false;

        if (input.proxy !== undefined) {
          const parsedProxy = yield* Effect.try({
            try: () => sanitizeProxyUrl(input.proxy!),
            catch: (error) => mapWagentError(error),
          });
          sanitizedProxyForConfig = parsedProxy.redacted;
          if (parsedProxy.hasCredentials) {
            nextProxySecret = input.proxy.trim();
            shouldConfirmLegacyProxyAfterWrite = pendingLegacyProxy !== null;
          } else if (!parsedProxy.redacted) {
            nextProxySecret = null;
            shouldConfirmLegacyProxyAfterWrite = pendingLegacyProxy !== null;
          } else if (pendingLegacyProxy !== null) {
            const legacyRedacted = yield* Effect.try({
              try: () => sanitizeProxyUrl(pendingLegacyProxy).redacted,
              catch: (error) => mapWagentError(error),
            }).pipe(Effect.orElseSucceed(() => ""));
            if (legacyRedacted === parsedProxy.redacted) {
              // Web UI echoed back the redacted proxy host: migrate pending legacy credentials first!
              const existingProxyOpt = yield* readSecretBytesStrict(SECRET_PROXY_URL);
              if (Option.isNone(existingProxyOpt)) {
                nextProxySecret = pendingLegacyProxy;
              }
            } else {
              nextProxySecret = null;
            }
            shouldConfirmLegacyProxyAfterWrite = true;
          } else {
            const existingProxyOpt = yield* readSecretBytesStrict(SECRET_PROXY_URL);
            if (Option.isSome(existingProxyOpt)) {
              const existingProxyStr = textDecoder.decode(existingProxyOpt.value).trim();
              const prevRedacted = yield* Effect.try({
                try: () => sanitizeProxyUrl(existingProxyStr).redacted,
                catch: (error) => mapWagentError(error),
              }).pipe(Effect.orElseSucceed(() => ""));
              if (prevRedacted !== parsedProxy.redacted) {
                nextProxySecret = null;
              }
            }
          }
        } else if (pendingLegacyProxy !== null) {
          const existingProxyOpt = yield* readSecretBytesStrict(SECRET_PROXY_URL);
          if (Option.isNone(existingProxyOpt)) {
            nextProxySecret = pendingLegacyProxy;
          }
          shouldConfirmLegacyProxyAfterWrite = true;
        }

        const configPatch = {
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
          ...(sanitizedProxyForConfig !== undefined ? { proxy: sanitizedProxyForConfig } : {}),
          ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}),
        };

        // Pure validation first so invalid config never touches secrets or disk.
        const validatedNextConfig = yield* Effect.try({
          try: () => runtime.validatePatch(configPatch),
          catch: (error) => mapWagentError(error),
        });

        const secretMutations: Array<{
          readonly name: string;
          readonly value: string | null;
        }> = [];
        if (input.telegramBotToken !== undefined) {
          secretMutations.push({
            name: SECRET_TELEGRAM_BOT_TOKEN,
            value: input.telegramBotToken,
          });
        }
        if (input.deepseekApiKey !== undefined) {
          secretMutations.push({
            name: SECRET_DEEPSEEK_API_KEY,
            value: input.deepseekApiKey,
          });
        }
        if (input.wkbToken !== undefined) {
          const trimmedWkb = input.wkbToken === null ? "" : input.wkbToken.trim();
          const canonicalNextKbUrl = canonicalizeWkbEndpointUrl(validatedNextConfig.kbUrl);
          if (trimmedWkb && canonicalNextKbUrl === null) {
            return yield* new WagentValidationError({
              reason: "wkbToken requires a valid HTTP/HTTPS kbUrl.",
            });
          }
          secretMutations.push({
            name: SECRET_WKB_TOKEN,
            value:
              trimmedWkb && canonicalNextKbUrl !== null
                ? encodeBoundWkbSecret({ token: trimmedWkb, kbUrl: canonicalNextKbUrl })
                : null,
          });
        } else if (
          input.kbUrl !== undefined &&
          canonicalizeWkbEndpointUrl(validatedNextConfig.kbUrl) !==
            canonicalizeWkbEndpointUrl(runtime.config.kbUrl)
        ) {
          const existingWkbOpt = yield* readSecretBytesStrict(SECRET_WKB_TOKEN);
          if (Option.isSome(existingWkbOpt)) {
            secretMutations.push({
              name: SECRET_WKB_TOKEN,
              value: null,
            });
          }
        }
        if (nextProxySecret !== undefined) {
          secretMutations.push({
            name: SECRET_PROXY_URL,
            value: nextProxySecret,
          });
        }

        // Strict read of ONLY modified secret keys so untouched secrets are never deleted on rollback.
        const previousModifiedSecrets = new Map<string, Option.Option<Uint8Array>>();
        for (const item of secretMutations) {
          const prev = yield* readSecretBytesStrict(item.name);
          previousModifiedSecrets.set(item.name, prev);
        }

        const attemptedSecretNames: string[] = [];
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const mutationExit = yield* Effect.exit(
              Effect.gen(function* () {
                for (const item of secretMutations) {
                  attemptedSecretNames.push(item.name);
                  yield* writeOptionalSecret(item.name, item.value);
                }
                yield* Effect.tryPromise({
                  try: () =>
                    runtime.updateConfig(configPatch, {
                      confirmLegacyProxyMigrated: shouldConfirmLegacyProxyAfterWrite,
                    }),
                  catch: (error) => mapWagentError(error),
                });
              }),
            );
            if (mutationExit._tag === "Failure") {
              const rollbackEntries: Array<{ readonly name: string; readonly detail: string }> = [];
              for (const name of [...new Set(attemptedSecretNames)].reverse()) {
                const res = yield* Effect.exit(
                  restoreSecretBytesStrict(
                    name,
                    previousModifiedSecrets.get(name) ?? Option.none(),
                  ),
                );
                if (res._tag === "Failure") {
                  const squashed = Cause.squash(res.cause);
                  const detail =
                    squashed instanceof Error && squashed.message
                      ? squashed.message
                      : String(squashed);
                  rollbackEntries.push({ name, detail: detail.replace(/\s+/gu, " ").trim() });
                }
              }
              if (rollbackEntries.length > 0) {
                const prefix = "Wagent config update failed; rollback failed for ";
                const namesAndPunctLen = rollbackEntries.reduce(
                  (sum, item) => sum + item.name.length + 5,
                  0,
                );
                const remainingBudget = Math.max(0, 390 - prefix.length - namesAndPunctLen);
                const perKeyDetail = Math.floor(remainingBudget / rollbackEntries.length);
                const formatted = rollbackEntries
                  .map((item) =>
                    perKeyDetail >= 8 && item.detail.length > 0
                      ? `${item.name}(${item.detail.slice(0, perKeyDetail)})`
                      : item.name,
                  )
                  .join(", ");
                return yield* new WagentRuntimeError({
                  reason: `${prefix}${formatted}`.slice(0, 398),
                });
              }
              return yield* Effect.failCause(mutationExit.cause);
            }
          }),
        );
      }),
    );

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
