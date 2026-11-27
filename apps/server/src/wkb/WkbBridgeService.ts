import {
  WkbBridgeError,
  detectWkbInstallation,
  runWkbAnnotate,
  runWkbExport,
  runWkbSubmit,
  type RunWkbAnnotateInput,
  type RunWkbSubmitInput,
  type WkbAnnotateResult,
  type WkbExportResult,
  type WkbInstallationStatus,
  type WkbSubmitResult,
} from "@t3tools/wkb-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

export class WkbServiceError extends Schema.TaggedError<WkbServiceError>()("WkbServiceError", {
  code: Schema.Literals([
    "unavailable",
    "invalid_source",
    "timeout",
    "aborted",
    "process_failed",
    "invalid_output",
  ]),
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class WkbBridgeService extends Context.Service<
  WkbBridgeService,
  {
    readonly status: Effect.Effect<WkbInstallationStatus>;
    readonly exportToScopedTemp: (input: {
      readonly source: string;
      readonly pdf?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<WkbExportResult, WkbServiceError, Scope.Scope>;
    readonly annotate: (
      input: RunWkbAnnotateInput,
    ) => Effect.Effect<WkbAnnotateResult, WkbServiceError>;
    readonly submit: (input: RunWkbSubmitInput) => Effect.Effect<WkbSubmitResult, WkbServiceError>;
  }
>()("t3/wkb/WkbBridgeService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const env = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const cwd = yield* HostProcess.WorkingDirectory;
  const lock = yield* Semaphore.make(1);

  const extraCandidateDirs = [
    path.resolve(cwd, "..", "kb"),
    path.resolve(cwd, "kb"),
    path.join(homeDir, "Wagent", "kb"),
    path.join(homeDir, "kb"),
  ];

  const allowedLocalRoots = [path.join(homeDir, "Wagent")];

  const detectStatus = (): WkbInstallationStatus =>
    detectWkbInstallation({
      env,
      homeDir,
      extraCandidateDirs,
    });

  const status: WkbBridgeService["Service"]["status"] = Effect.sync(() => detectStatus()).pipe(
    Effect.withSpan("WkbBridgeService.status"),
  );

  const exportToScopedTemp: WkbBridgeService["Service"]["exportToScopedTemp"] = Effect.fn(
    "WkbBridgeService.exportToScopedTemp",
  )(function* (input) {
    const installed = detectStatus();
    if (!installed.available || !installed.kbDir || !installed.uvPath) {
      return yield* new WkbServiceError({
        code: "unavailable",
        reason:
          "Local wkb CLI or uv binary is not available on this environment. Set T3CODE_WKB_DIR or install wkb under ~/kb.",
      });
    }

    const exportId = yield* random.uuidV4();
    const outDir = path.join(config.stateDir, "research-library", "tmp", `wkb-${exportId}`);

    yield* Effect.acquireRelease(
      fs.makeDirectory(outDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WkbServiceError({
              code: "process_failed",
              reason: "Could not prepare temporary wkb export directory.",
              cause,
            }),
        ),
      ),
      () => fs.remove(outDir, { recursive: true, force: true }).pipe(Effect.ignore),
    );

    return yield* lock.withPermits(1)(
      Effect.tryPromise({
        try: (signal) =>
          runWkbExport(
            {
              source: input.source,
              outDir,
              pdf: input.pdf,
            },
            {
              kbDir: installed.kbDir!,
              uvBinary: installed.uvPath!,
              env,
              allowedLocalRoots,
              timeoutMs: input.timeoutMs,
              signal,
            },
          ),
        catch: (cause) => {
          if (cause instanceof WkbBridgeError) {
            return new WkbServiceError({
              code: cause.code,
              reason: cause.message.slice(0, 400),
              cause,
            });
          }
          return new WkbServiceError({
            code: "process_failed",
            reason: "wkb export failed unexpectedly.",
            cause,
          });
        },
      }),
    );
  });

  const secretStoreOpt = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const textDecoder = new TextDecoder();

  const readRemoteToken = Effect.gen(function* () {
    if (Option.isSome(secretStoreOpt)) {
      const stored = yield* secretStoreOpt.value
        .get("wagent-wkb-token")
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(stored)) {
        const decoded = textDecoder.decode(stored.value).trim();
        if (decoded.length > 0) return decoded;
      }
    }
    return env.T3CODE_WKB_TOKEN?.trim() || env.WKB_TOKEN?.trim() || null;
  });

  const mapWkbError = (cause: unknown, fallback: string): WkbServiceError => {
    if (cause instanceof WkbBridgeError) {
      return new WkbServiceError({
        code: cause.code,
        reason: cause.message.slice(0, 400),
        cause,
      });
    }
    return new WkbServiceError({
      code: "process_failed",
      reason: fallback,
      cause,
    });
  };

  const annotate: WkbBridgeService["Service"]["annotate"] = Effect.fn("WkbBridgeService.annotate")(
    function* (input) {
      const installed = detectStatus();
      const remoteToken = yield* readRemoteToken;
      return yield* lock.withPermits(1)(
        Effect.tryPromise({
          try: (signal) =>
            runWkbAnnotate(input, {
              kbDir: installed.kbDir,
              remoteUrl: installed.remoteUrl,
              remoteToken,
              uvBinary: installed.uvPath ?? undefined,
              env,
              signal,
            }),
          catch: (cause) => mapWkbError(cause, "wkb annotate failed unexpectedly."),
        }),
      );
    },
  );

  const submit: WkbBridgeService["Service"]["submit"] = Effect.fn("WkbBridgeService.submit")(
    function* (input) {
      const installed = detectStatus();
      const remoteToken = yield* readRemoteToken;
      return yield* lock.withPermits(1)(
        Effect.tryPromise({
          try: (signal) =>
            runWkbSubmit(input, {
              kbDir: installed.kbDir,
              remoteUrl: installed.remoteUrl,
              remoteToken,
              uvBinary: installed.uvPath ?? undefined,
              env,
              signal,
            }),
          catch: (cause) => mapWkbError(cause, "wkb submit failed unexpectedly."),
        }),
      );
    },
  );

  return WkbBridgeService.of({
    status,
    exportToScopedTemp,
    annotate,
    submit,
  });
});

export const layer = Layer.effect(WkbBridgeService, make);
