import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  LibrarySsrfRejectedError as DomainSsrfRejectedError,
  type ParsedFeedItem,
} from "@t3tools/research-library";
import { parseFeedXml, searchImaKnowledgeBase } from "@t3tools/research-library/server";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import * as LibraryService from "./LibraryService.ts";
import * as ReadingAiRunner from "./ReadingAiRunner.ts";

describe("LibraryService M3 periodic feeds, pause, daily AI budget, and wkb work harvest", () => {
  it.effect(
    "deduplicates repeated feed runs, enforces immediate pause, enforces hard daily AI budget, and runs wkb work harvest",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-m3-" });
          const envId = EnvironmentId.make("env-m3-feeds");

          let aiCalls = 0;
          let harvestProjectCalled: string | undefined;

          const mockTextGenerators = Layer.mock(TextGenerators.TextGenerators)({
            listModels: () =>
              Effect.succeed({
                models: [{ id: "gpt-4o-mini", name: "GPT-4o Mini" }],
              }),
            runner: () =>
              Effect.succeed((() =>
                Effect.sync(() => {
                  aiCalls += 1;
                  return {
                    problem: "Long context efficiency",
                    method: "Sparse attention routing",
                    results: "2x faster inference",
                    limitations: "Needs tuned block sizes",
                    takeaways: ["Use sparse blocks for retrieval-heavy agents"],
                  } as never;
                })) as never),
          });

          const mockRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([]),
            getInstance: () => Effect.undefined,
          });

          const mockWkb = Layer.mock(WkbBridgeService.WkbBridgeService)({
            workHarvest: (input) =>
              Effect.sync(() => {
                harvestProjectCalled = input.project;
                return {
                  mode: "local" as const,
                  project: input.project ?? null,
                  summary: `Harvested project ${input.project ?? "all"} into wkb work.`,
                };
              }),
          });

          const textGeneratorsConfig = {
            [ProviderInstanceId.make("tg-direct")]: {
              kind: "openaiCompatible" as const,
              label: "OpenAI Compatible",
              enabled: true,
              apiKey: "sk-test-m3",
              baseUrl: "https://api.example.invalid/v1",
            },
          };

          const baseLayers = Layer.mergeAll(
            ServerConfig.layerTest(tempDir, tempDir),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
            ServerSettings.layerTest({ textGenerators: textGeneratorsConfig }),
            mockTextGenerators,
            mockRegistry,
            mockWkb,
          );

          const runnerLayer = ReadingAiRunner.layer.pipe(Layer.provide(baseLayers));
          const libraryLayer = LibraryService.layer.pipe(
            Layer.provide(Layer.mergeAll(baseLayers, runnerLayer)),
          );
          const built = yield* Layer.build(libraryLayer);
          const library = built.mapUnsafe.get(
            LibraryService.LibraryService.key,
          ) as LibraryService.LibraryService["Service"];

          // 1. Create an arXiv feed with autoSummarize off initially
          const feed = yield* library.upsertFeed({
            name: "arXiv Systems",
            kind: "arxiv",
            url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI",
            tags: ["arxiv", "systems"],
            intervalMinutes: 60,
            maxItemsPerRun: 10,
            autoSummarize: false,
            dailyAiBudget: 1,
          });
          expect(feed.enabled).toBe(true);

          const batch1: ReadonlyArray<ParsedFeedItem> = [
            {
              externalId: "arxiv:2501.00001",
              title: "Paper One",
              url: "https://arxiv.org/abs/2501.00001",
              summary: "First abstract on agent memory.",
              authors: ["Alice"],
              categories: ["cs.AI"],
              publishedAt: "2026-11-24T00:00:00Z",
            },
            {
              externalId: "arxiv:2501.00002",
              title: "Paper Two",
              url: "https://arxiv.org/abs/2501.00002",
              summary: "Second abstract on structured reading.",
              authors: ["Bob"],
              categories: ["cs.CL"],
              publishedAt: "2026-11-24T01:00:00Z",
            },
          ];

          let fetchCalls = 0;
          const run1 = yield* library.runFeedNow(
            { id: feed.id },
            {
              fetchFeedItemsFn: async () => {
                fetchCalls += 1;
                return batch1;
              },
            },
          );
          expect(run1.skippedPaused).toBe(false);
          expect(run1.importedCount).toBe(2);
          expect(run1.deduplicatedCount).toBe(0);
          expect(run1.importedEntryIds).toHaveLength(2);
          expect(aiCalls).toBe(0);

          // 2. Re-running the same feed is completely idempotent (0 new entries, 2 deduplicated)
          const run2 = yield* library.runFeedNow(
            { id: feed.id },
            {
              fetchFeedItemsFn: async () => {
                fetchCalls += 1;
                return batch1;
              },
            },
          );
          expect(run2.importedCount).toBe(0);
          expect(run2.deduplicatedCount).toBe(2);
          const listed = yield* library.list({ limit: 20 });
          expect(listed.total).toBe(2);

          // 3. Pausing takes immediate effect: neither runFeedNow nor runDueFeeds calls fetch!
          const paused = yield* library.setFeedEnabled({ id: feed.id, enabled: false });
          expect(paused.enabled).toBe(false);
          const fetchCallsBeforePause = fetchCalls;
          const runPaused = yield* library.runFeedNow(
            { id: feed.id },
            {
              fetchFeedItemsFn: async () => {
                fetchCalls += 1;
                return batch1;
              },
            },
          );
          expect(runPaused.skippedPaused).toBe(true);
          expect(fetchCalls).toBe(fetchCallsBeforePause);

          const dueWhilePaused = yield* library.runDueFeeds({
            fetchFeedItemsFn: async () => {
              fetchCalls += 1;
              return batch1;
            },
          });
          expect(dueWhilePaused).toHaveLength(0);
          expect(fetchCalls).toBe(fetchCallsBeforePause);

          // 4. Enable autoSummarize with explicit model + dailyAiBudget = 1 across 2 brand-new items
          const resumedWithAi = yield* library.upsertFeed({
            id: feed.id,
            name: feed.name,
            kind: feed.kind,
            url: feed.url,
            tags: [...feed.tags],
            enabled: true,
            intervalMinutes: 60,
            maxItemsPerRun: 10,
            autoSummarize: true,
            aiInstanceId: "tg-direct",
            aiModel: "gpt-4o-mini",
            dailyAiBudget: 1,
          });
          expect(resumedWithAi.autoSummarize).toBe(true);

          const batch2: ReadonlyArray<ParsedFeedItem> = [
            ...batch1,
            {
              externalId: "arxiv:2501.00003",
              title: "Paper Three",
              url: "https://arxiv.org/abs/2501.00003",
              summary: "Third abstract eligible for auto summary.",
              authors: ["Carol"],
              categories: ["cs.AI"],
              publishedAt: "2026-11-25T00:00:00Z",
            },
            {
              externalId: "arxiv:2501.00004",
              title: "Paper Four",
              url: "https://arxiv.org/abs/2501.00004",
              summary: "Fourth abstract blocked by daily AI budget cap.",
              authors: ["Dave"],
              categories: ["cs.AI"],
              publishedAt: "2026-11-25T01:00:00Z",
            },
          ];

          const run3 = yield* library.runFeedNow(
            { id: feed.id },
            {
              fetchFeedItemsFn: async () => batch2,
            },
          );
          expect(run3.importedCount).toBe(2);
          expect(run3.deduplicatedCount).toBe(2);
          expect(run3.summarizedCount).toBe(1);
          expect(run3.budgetExhaustedCount).toBe(1);
          expect(aiCalls).toBe(1);

          // Verify insight persisted on first new entry and NOT on second
          const state3 = yield* library.getReadingState({ entryId: run3.importedEntryIds[0]! });
          expect(state3.insights.some((ins) => ins.kind === "summary5")).toBe(true);
          const state4 = yield* library.getReadingState({ entryId: run3.importedEntryIds[1]! });
          expect(state4.insights.some((ins) => ins.kind === "summary5")).toBe(false);

          const feedsSummary = yield* library.listFeeds();
          expect(feedsSummary.dailyAiUsed).toBe(1);

          // 5. wkb work harvest delegates cleanly to WkbBridgeService
          const harvestResult = yield* library.runWorkHarvest({ project: "Wagent" });
          expect(harvestProjectCalled).toBe("Wagent");
          expect(harvestResult.mode).toBe("local");
          expect(harvestResult.summary).toContain("Harvested project Wagent");

          // 6. Strict model check (#10): auto-summarize or strictModel rejects unknown model without fallback
          const strictFail = yield* library
            .runReadingAiAction({
              entryId: run3.importedEntryIds[0]!,
              action: "summary5",
              instanceId: "tg-direct",
              model: "non-existent-model",
              strictModel: true,
            })
            .pipe(Effect.result);
          expect(strictFail._tag).toBe("Failure");

          // 7. Pausing mid-flight interrupts an in-progress feed run immediately (#9)
          let notifyFetchStarted!: () => void;
          const fetchStarted = new Promise<void>((resolve) => {
            notifyFetchStarted = resolve;
          });
          const inFlightFiber = yield* Effect.forkChild(
            library.runFeedNow(
              { id: feed.id },
              {
                fetchFeedItemsFn: async (_url, _kind, signal) => {
                  notifyFetchStarted();
                  return await new Promise<ReadonlyArray<ParsedFeedItem>>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("aborted")));
                  });
                },
              },
            ),
          );
          yield* Effect.promise(() => fetchStarted);
          yield* library.setFeedEnabled({ id: feed.id, enabled: false });
          const interruptedRes = yield* Fiber.join(inFlightFiber);
          expect(interruptedRes.skippedPaused).toBe(true);
          expect(interruptedRes.importedCount).toBe(0);

          // 8. Scan past already-seen items up to maxItemsPerRun new items (#11, #12)
          yield* library.save({
            kind: "web",
            title: "Manual Pre-Existing Bookmark",
            url: "https://arxiv.org/abs/2501.00005",
            body: "Saved manually before feed ran.",
          });
          yield* library.upsertFeed({
            id: feed.id,
            name: feed.name,
            kind: feed.kind,
            url: feed.url,
            enabled: true,
            maxItemsPerRun: 1,
            autoSummarize: false,
            dailyAiBudget: 0,
          });
          const runPastSeen = yield* library.runFeedNow(
            { id: feed.id },
            {
              fetchFeedItemsFn: async () => {
                // Prepend 255 already-seen copies so scanning continues past 250 feed items.
                const fillerSeen = Array.from({ length: 255 }, () => batch1[0]!);
                return [
                  ...fillerSeen,
                  ...batch1,
                  {
                    externalId: "arxiv:2501.00005",
                    title: "Manual Pre-Existing Bookmark",
                    url: "https://arxiv.org/abs/2501.00005",
                    summary: "Should bind seen row without failing.",
                    authors: [],
                    categories: [],
                    publishedAt: null,
                  },
                  {
                    externalId: "arxiv:2501.00006",
                    title: "Brand New Behind 258 Seen Items",
                    url: "https://arxiv.org/abs/2501.00006",
                    summary: "Must still be imported past index 250!",
                    authors: [],
                    categories: [],
                    publishedAt: null,
                  },
                ];
              },
            },
          );
          expect(runPastSeen.deduplicatedCount).toBe(258);
          expect(runPastSeen.importedCount).toBe(1);

          // Verify maxBodyChars truncates returned entry body.
          const truncatedEntry = yield* library.get({
            id: runPastSeen.importedEntryIds[0]!,
            maxBodyChars: 12,
          });
          expect(truncatedEntry.entry.body.length).toBeLessThanOrEqual(12);

          // 9. Cross-entry question ID collision (#19), MCP first-item truncation (#23), and includePages=false (#24)
          const qEntryA = run3.importedEntryIds[0]!;
          const qEntryB = run3.importedEntryIds[1]!;
          const qCreated = yield* library.upsertReadingQuestion({
            id: "shared-q-id",
            entryId: qEntryA,
            physicalPage: 1,
            question: "Belongs to entry A",
          });
          expect(qCreated.entryId).toBe(qEntryA);
          const crossCollision = yield* library
            .upsertReadingQuestion({
              id: "shared-q-id",
              entryId: qEntryB,
              physicalPage: 1,
              question: "Attempted hijack from entry B",
            })
            .pipe(Effect.result);
          expect(crossCollision._tag).toBe("Failure");

          yield* library.upsertReadingParagraph({
            entryId: qEntryA,
            physicalPage: 1,
            anchor: "long-note-anchor",
            quote: "Q".repeat(500),
            note: "N".repeat(2_000),
            highlighted: true,
          });
          const mcpNotes = yield* library.getReadingNotesForMcp({
            id: qEntryA,
            maxChars: 300,
          });
          expect(mcpNotes.truncated).toBe(true);
          expect(mcpNotes.items[0]!.note.length).toBeLessThan(300);

          const noPagesState = yield* library.getReadingState({
            entryId: qEntryA,
            includePages: false,
          });
          expect(noPagesState.pages).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("resolves relative RSS links safely and blocks ima private DNS + 3xx Bearer redirects (#12, #13)", async () => {
    const parsedRss = parseFeedXml(
      `<rss><channel>
        <item><title>Relative Item</title><link>/posts/hello-world</link><description>Body</description></item>
        <item><title>Broken Link Item</title><link>http://[::1</link><description>Still kept without URL</description></item>
      </channel></rss>`,
      "rss",
      "https://blog.example.com/feed.xml",
    );
    expect(parsedRss).toHaveLength(2);
    expect(parsedRss[0]?.url).toBe("https://blog.example.com/posts/hello-world");
    expect(parsedRss[1]?.url).toBeNull();

    await expect(
      searchImaKnowledgeBase({
        baseUrl: "https://ima.example.com/api",
        apiKey: "secret-ima-key",
        knowledgeBaseId: "kb-1",
        query: "test",
        dnsResolver: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: async () => new Response("{}", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(DomainSsrfRejectedError);

    await expect(
      searchImaKnowledgeBase({
        baseUrl: "https://ima.example.com/api",
        apiKey: "secret-ima-key",
        knowledgeBaseId: "kb-1",
        query: "test",
        dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
      }),
    ).rejects.toBeInstanceOf(DomainSsrfRejectedError);
  });
});
