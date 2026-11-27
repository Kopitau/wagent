import {
  type LibraryComposeDraftInput,
  type LibraryComposeDraftResult,
  type LibraryDeleteInput,
  type LibraryDeleteResult,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  type LibraryEntry,
  type LibraryGetInput,
  type LibraryGetResult,
  type LibraryImportTextFileInput,
  type LibraryListInput,
  type LibraryListResult,
  LibraryNotFoundError,
  type LibraryRpcError,
  type LibrarySaveInput,
  LibraryStorageError,
  type LibraryUpdateInput,
  LibraryValidationError,
} from "@t3tools/contracts";
import {
  LibraryDuplicateUrlError as DomainDuplicateUrlError,
  LibraryEditConflictError as DomainEditConflictError,
  LibraryNotFoundError as DomainNotFoundError,
  LibraryValidationError as DomainValidationError,
} from "@t3tools/research-library";
import { openLibraryDatabase } from "@t3tools/research-library/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

function mapLibraryError(operation: string, cause: unknown): LibraryRpcError {
  if (cause instanceof DomainValidationError) {
    return new LibraryValidationError({
      field: cause.field.slice(0, 64) || "input",
      reason: cause.message.slice(0, 240) || "Invalid input.",
    });
  }
  if (cause instanceof DomainNotFoundError) {
    return new LibraryNotFoundError({ entryId: cause.entryId });
  }
  if (cause instanceof DomainDuplicateUrlError) {
    return new LibraryDuplicateUrlError({ existingEntryId: cause.existingEntryId });
  }
  if (cause instanceof DomainEditConflictError) {
    return new LibraryEditConflictError({
      entryId: cause.entryId,
      expectedRevision: cause.expectedRevision,
      currentRevision: cause.currentRevision,
    });
  }
  return new LibraryStorageError({ operation, cause });
}

export class LibraryService extends Context.Service<
  LibraryService,
  {
    readonly list: (input: LibraryListInput) => Effect.Effect<LibraryListResult, LibraryRpcError>;
    readonly get: (input: LibraryGetInput) => Effect.Effect<LibraryGetResult, LibraryRpcError>;
    readonly save: (input: LibrarySaveInput) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly importTextFile: (
      input: LibraryImportTextFileInput,
    ) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly update: (input: LibraryUpdateInput) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly delete: (
      input: LibraryDeleteInput,
    ) => Effect.Effect<LibraryDeleteResult, LibraryRpcError>;
    readonly composeDraft: (
      input: LibraryComposeDraftInput,
    ) => Effect.Effect<LibraryComposeDraftResult, LibraryRpcError>;
  }
>()("t3/library/LibraryService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const path = yield* Path.Path;
  const isWindows = (yield* HostProcess.Platform) === "win32";
  const dbPath = path.join(config.stateDir, "research-library", "library.sqlite");

  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openLibraryDatabase({ dbPath, isWindows }),
      catch: (cause) => new LibraryStorageError({ operation: "open", cause }),
    }),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      }),
  );

  const lock = yield* Semaphore.make(1);

  const run = <A>(operation: string, fn: () => A): Effect.Effect<A, LibraryRpcError> =>
    lock.withPermits(1)(
      Effect.try({
        try: fn,
        catch: (cause) => mapLibraryError(operation, cause),
      }),
    );

  const list: LibraryService["Service"]["list"] = Effect.fn("LibraryService.list")(
    function* (input) {
      return yield* run("list", () => database.listEntries(input));
    },
  );

  const get: LibraryService["Service"]["get"] = Effect.fn("LibraryService.get")(function* (input) {
    return yield* run("get", () => {
      const entry = database.getEntry(input.id);
      if (entry === null) {
        throw new DomainNotFoundError(input.id);
      }
      return { entry };
    });
  });

  const save: LibraryService["Service"]["save"] = Effect.fn("LibraryService.save")(
    function* (input) {
      return yield* run("save", () => database.saveEntry(input));
    },
  );

  const importTextFile: LibraryService["Service"]["importTextFile"] = Effect.fn(
    "LibraryService.importTextFile",
  )(function* (input) {
    return yield* run("importTextFile", () => database.importTextFile(input));
  });

  const update: LibraryService["Service"]["update"] = Effect.fn("LibraryService.update")(
    function* (input) {
      return yield* run("update", () => database.updateEntry(input));
    },
  );

  const del: LibraryService["Service"]["delete"] = Effect.fn("LibraryService.delete")(
    function* (input) {
      return yield* run("delete", () => database.deleteEntry(input));
    },
  );

  const composeDraft: LibraryService["Service"]["composeDraft"] = Effect.fn(
    "LibraryService.composeDraft",
  )(function* (input) {
    const environmentId = yield* environment.getEnvironmentId;
    return yield* run("composeDraft", () =>
      database.composeDraft({
        environmentId,
        entryIds: input.entryIds,
        question: input.question,
      }),
    );
  });

  return LibraryService.of({
    list,
    get,
    save,
    importTextFile,
    update,
    delete: del,
    composeDraft,
  });
});

export const layer = Layer.effect(LibraryService, make);
