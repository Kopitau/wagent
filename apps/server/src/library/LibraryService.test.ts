import { EnvironmentId, isLibraryEditConflictError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LibraryService from "./LibraryService.ts";

function makeTestLibraryLayer(environmentId: EnvironmentId, baseDir: string) {
  const serverEnvironmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  });

  return LibraryService.layer.pipe(
    Layer.provide(serverEnvironmentLayer),
    Layer.provide(ServerConfig.ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provide(NodeServices.layer),
  );
}

describe("LibraryService", () => {
  it.effect(
    "isolates library databases across environments and composes environment-scoped drafts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-svc-" });
        const dirA = path.join(rootDir, "env-a");
        const dirB = path.join(rootDir, "env-b");
        yield* fs.makeDirectory(dirA, { recursive: true });
        yield* fs.makeDirectory(dirB, { recursive: true });

        const envA = EnvironmentId.make("env-a");
        const envB = EnvironmentId.make("env-b");

        const entryA = yield* Effect.gen(function* () {
          const service = yield* LibraryService.LibraryService;
          const saved = yield* service.save({
            kind: "note",
            title: "量子纠错笔记",
            body: "表面码在二维晶格上实现容错量子计算。",
            note: "仅存在于环境 A",
            tags: ["量子"],
          });

          const listResult = yield* service.list({ query: "量子" });
          expect(listResult.total).toBe(1);
          expect(listResult.items[0]?.id).toBe(saved.id);

          const updated = yield* service.update({
            id: saved.id,
            expectedRevision: saved.revision,
            note: "已更新笔记",
          });
          expect(updated.revision).toBe(2);

          const conflict = yield* service
            .update({
              id: saved.id,
              expectedRevision: 1,
              note: "过期覆盖",
            })
            .pipe(Effect.flip);
          expect(isLibraryEditConflictError(conflict)).toBe(true);
          if (isLibraryEditConflictError(conflict)) {
            expect(conflict.currentRevision).toBe(2);
          }

          const draft = yield* service.composeDraft({
            entryIds: [saved.id],
            question: "总结表面码的核心特点",
          });
          expect(draft.prompt).toContain("environmentId: env-a");
          expect(draft.prompt).toContain(`entryId: ${saved.id}`);
          expect(draft.prompt).toContain("revision: 2");
          return updated;
        }).pipe(Effect.provide(makeTestLibraryLayer(envA, dirA)));

        // Environment B has its own stateDir and must never see entries from Environment A.
        yield* Effect.gen(function* () {
          const service = yield* LibraryService.LibraryService;
          const listB = yield* service.list({});
          expect(listB.total).toBe(0);

          const lookupA = yield* service.get({ id: entryA.id }).pipe(Effect.flip);
          expect(lookupA._tag).toBe("LibraryNotFoundError");

          const imported = yield* service.importTextFile({
            fileName: "env-b.md",
            content: "# Env B Doc\n\nSeparate library database.",
          });
          expect(imported.title).toBe("Env B Doc");
        }).pipe(Effect.provide(makeTestLibraryLayer(envB, dirB)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
