import {
  WkbBridgeError,
  canonicalizeWkbEndpointUrl,
  detectWkbInstallation,
  runWkbAnnotate,
  runWkbExport,
  runWkbSubmit,
  runWkbWorkHarvest,
  type RunWkbAnnotateInput,
  type RunWkbAnnotateOptions,
  type RunWkbExportOptions,
  type RunWkbSubmitInput,
  type RunWkbWorkHarvestInput,
  type WkbAnnotateResult,
  type WkbExportResult,
  type WkbInstallationStatus,
  type WkbSubmitResult,
  type WkbWorkHarvestResult,
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
    readonly workHarvest: (
      input: RunWkbWorkHarvestInput,
    ) => Effect.Effect<WkbWorkHarvestResult, WkbServiceError>;
  }
>()("t3/wkb/WkbBridgeService") {}

export interface WkbBridgeServiceTestOverrides {
  readonly dnsResolver?: RunWkbExportOptions["dnsResolver"] | undefined;
  readonly fetchImpl?: RunWkbAnnotateOptions["fetchImpl"] | undefined;
}

const make = Effect.fn("WkbBridgeService.make")(function* (
  overrides?: WkbBridgeServiceTestOverrides,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const env = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const lock = yield* Semaphore.make(1);

  const extraCandidateDirs = [path.join(homeDir, "Wagent", "kb"), path.join(homeDir, "kb")];

  const allowedLocalRoots = [path.join(homeDir, "Wagent")];

  const secretStoreOpt = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const textDecoder = new TextDecoder();
  const wagentConfigPath = path.join(config.stateDir, "wagent", "config.json");
  const WagentKbUrlJson = Schema.fromJsonString(
    Schema.Struct({
      kbUrl: Schema.String,
      explicitPaths: Schema.optional(
        Schema.Struct({
          kbUrl: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  );
  const decodeWagentKbUrl = Schema.decodeOption(WagentKbUrlJson);
  const BoundWkbSecretJson = Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      kbUrl: Schema.String,
    }),
  );
  const decodeBoundWkbSecret = Schema.decodeOption(BoundWkbSecretJson);

  // Strict read: returns null when config.json does not exist or fails to parse (never substitutes a default URL).
  const readPersistedWagentKbUrl = Effect.gen(function* () {
    const exists = yield* fs.exists(wagentConfigPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return null;
    const rawOpt = yield* fs.readFileString(wagentConfigPath).pipe(Effect.option);
    if (Option.isNone(rawOpt) || !rawOpt.value.trim()) return null;
    const decoded = decodeWagentKbUrl(rawOpt.value);
    if (Option.isNone(decoded)) return null;
    const canonical = canonicalizeWkbEndpointUrl(decoded.value.kbUrl);
    if (canonical === null) return null;
    return {
      kbUrl: canonical,
      isExplicit: decoded.value.explicitPaths?.kbUrl !== false,
    };
  });

  // Bind every remote wkb token strictly to the exact canonical endpoint URL sent on the wire.
  const resolveBoundRemoteTarget = Effect.gen(function* () {
    const rawEnvUrl = env.T3CODE_WKB_REMOTE_URL?.trim() ?? env.WKB_REMOTE_URL?.trim();
    const canonicalEnvUrl =
      rawEnvUrl !== undefined ? canonicalizeWkbEndpointUrl(rawEnvUrl) : undefined;
    const envToken = env.T3CODE_WKB_TOKEN?.trim() || env.WKB_TOKEN?.trim() || null;

    if (envToken !== null) {
      return {
        remoteUrlOverride: canonicalEnvUrl ?? rawEnvUrl,
        remoteToken: canonicalEnvUrl !== null ? envToken : null,
      };
    }

    let rawStoredSecret: string | null = null;
    if (Option.isSome(secretStoreOpt)) {
      const stored = yield* secretStoreOpt.value
        .get("wagent-wkb-token")
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(stored)) {
        const decoded = textDecoder.decode(stored.value).trim();
        if (decoded.length > 0) rawStoredSecret = decoded;
      }
    }

    const persistedWagent = yield* readPersistedWagentKbUrl;
    const persistedWagentKbUrl = persistedWagent?.kbUrl ?? null;
    if (rawStoredSecret === null) {
      return {
        remoteUrlOverride:
          rawEnvUrl !== undefined ? (canonicalEnvUrl ?? "") : (persistedWagentKbUrl ?? undefined),
        remoteToken: null,
      };
    }

    let boundToken: string | null = null;
    let boundCanonicalUrl: string | null = null;
    if (rawStoredSecret.startsWith("{")) {
      const parsedSecret = decodeBoundWkbSecret(rawStoredSecret);
      if (Option.isSome(parsedSecret)) {
        const tok = parsedSecret.value.token.trim();
        const canonicalSecretUrl = canonicalizeWkbEndpointUrl(parsedSecret.value.kbUrl);
        const configMatches =
          persistedWagentKbUrl === null || persistedWagentKbUrl === canonicalSecretUrl;
        if (tok.length > 0 && canonicalSecretUrl !== null && configMatches) {
          boundToken = tok;
          boundCanonicalUrl = canonicalSecretUrl;
        }
      }
    } else if (persistedWagent !== null && persistedWagent.isExplicit) {
      boundToken = rawStoredSecret;
      boundCanonicalUrl = persistedWagent.kbUrl;
    }

    if (boundToken === null || boundCanonicalUrl === null) {
      return {
        remoteUrlOverride:
          rawEnvUrl !== undefined ? (canonicalEnvUrl ?? "") : (persistedWagentKbUrl ?? undefined),
        remoteToken: null,
      };
    }

    if (rawEnvUrl === undefined) {
      return {
        remoteUrlOverride: boundCanonicalUrl,
        remoteToken: boundToken,
      };
    }

    const sameTarget = canonicalEnvUrl !== null && canonicalEnvUrl === boundCanonicalUrl;

    return {
      remoteUrlOverride: canonicalEnvUrl ?? "",
      remoteToken: sameTarget ? boundToken : null,
    };
  });

  const detectStatus = (
    hasRemoteToken: boolean,
    remoteUrlOverride?: string | undefined,
  ): WkbInstallationStatus =>
    detectWkbInstallation({
      env,
      homeDir,
      extraCandidateDirs,
      ...(remoteUrlOverride !== undefined ? { remoteUrl: remoteUrlOverride } : {}),
      hasRemoteToken,
    });

  const status: WkbBridgeService["Service"]["status"] = Effect.gen(function* () {
    const bound = yield* resolveBoundRemoteTarget;
    return detectStatus(bound.remoteToken !== null, bound.remoteUrlOverride);
  }).pipe(Effect.withSpan("WkbBridgeService.status"));

  const exportToScopedTemp: WkbBridgeService["Service"]["exportToScopedTemp"] = Effect.fn(
    "WkbBridgeService.exportToScopedTemp",
  )(function* (input) {
    const installed = detectStatus(false);
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
              dnsResolver: overrides?.dnsResolver,
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
      const bound = yield* resolveBoundRemoteTarget;
      const installed = detectStatus(bound.remoteToken !== null, bound.remoteUrlOverride);
      return yield* lock.withPermits(1)(
        Effect.tryPromise({
          try: (signal) =>
            runWkbAnnotate(input, {
              kbDir: installed.kbDir,
              remoteUrl: installed.remoteUrl,
              remoteToken: bound.remoteToken,
              uvBinary: installed.uvPath ?? undefined,
              fetchImpl: overrides?.fetchImpl,
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
      const bound = yield* resolveBoundRemoteTarget;
      const installed = detectStatus(bound.remoteToken !== null, bound.remoteUrlOverride);
      return yield* lock.withPermits(1)(
        Effect.tryPromise({
          try: (signal) =>
            runWkbSubmit(input, {
              kbDir: installed.kbDir,
              remoteUrl: installed.remoteUrl,
              remoteToken: bound.remoteToken,
              uvBinary: installed.uvPath ?? undefined,
              fetchImpl: overrides?.fetchImpl,
              env,
              signal,
            }),
          catch: (cause) => mapWkbError(cause, "wkb submit failed unexpectedly."),
        }),
      );
    },
  );

  const workHarvest: WkbBridgeService["Service"]["workHarvest"] = Effect.fn(
    "WkbBridgeService.workHarvest",
  )(function* (input) {
    const bound = yield* resolveBoundRemoteTarget;
    const installed = detectStatus(bound.remoteToken !== null, bound.remoteUrlOverride);
    return yield* lock.withPermits(1)(
      Effect.tryPromise({
        try: (signal) =>
          runWkbWorkHarvest(input, {
            kbDir: installed.kbDir,
            remoteUrl: installed.remoteUrl,
            remoteToken: bound.remoteToken,
            uvBinary: installed.uvPath ?? undefined,
            fetchImpl: overrides?.fetchImpl,
            env,
            signal,
          }),
        catch: (cause) => mapWkbError(cause, "wkb work harvest failed unexpectedly."),
      }),
    );
  });

  return WkbBridgeService.of({
    status,
    exportToScopedTemp,
    annotate,
    submit,
    workHarvest,
  });
});

export const layer = Layer.effect(WkbBridgeService, make());

export const makeLayer = (overrides?: WkbBridgeServiceTestOverrides) =>
  Layer.effect(WkbBridgeService, make(overrides));
