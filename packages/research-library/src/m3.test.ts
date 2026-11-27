// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Non-Effect storage package unit tests use node fs/path and deterministic Date.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { LibrarySsrfRejectedError, LibraryValidationError } from "./errors.ts";
import { fetchFeedItems, openLibraryDatabase, parseFeedXml } from "./server/libraryServer.ts";

const tempDirs: string[] = [];

async function makeTempDbPath(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-library-m3-"));
  tempDirs.push(dir);
  return NodePath.join(dir, "library.sqlite");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const SAMPLE_ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: cat:cs.AI</title>
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <published>2025-01-01T12:00:00Z</published>
    <title>Sparse Attention Routing
      in Long-Context Agents</title>
    <summary>We introduce sparse routing for agent memory.</summary>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Chen</name></author>
    <link href="http://arxiv.org/abs/2501.00001v1" rel="alternate" type="text/html"/>
    <category term="cs.AI"/>
    <category term="cs.CL"/>
  </entry>
</feed>`;

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Systems Blog</title>
    <item>
      <guid>post-42</guid>
      <title><![CDATA[SQLite &amp; FTS5 Deep Dive]]></title>
      <link>https://systems.example.org/sqlite-fts5</link>
      <description><![CDATA[<p>Practical indexing notes for local-first apps.</p>]]></description>
      <dc:creator>Jane Doe</dc:creator>
      <category>databases</category>
    </item>
  </channel>
</rss>`;

describe("research-library M3 feeds, deduplication, pause, and daily AI budget", () => {
  it("parses arXiv Atom and RSS 2.0 feeds accurately", () => {
    const arxivItems = parseFeedXml(SAMPLE_ARXIV_ATOM, "arxiv");
    expect(arxivItems).toHaveLength(1);
    expect(arxivItems[0]?.title).toBe("Sparse Attention Routing in Long-Context Agents");
    expect(arxivItems[0]?.url).toBe("https://arxiv.org/abs/2501.00001v1");
    expect(arxivItems[0]?.authors).toEqual(["Alice Smith", "Bob Chen"]);
    expect(arxivItems[0]?.categories).toEqual(["cs.AI", "cs.CL"]);

    const rssItems = parseFeedXml(SAMPLE_RSS, "rss");
    expect(rssItems).toHaveLength(1);
    expect(rssItems[0]?.externalId).toBe("post-42");
    expect(rssItems[0]?.title).toBe("SQLite & FTS5 Deep Dive");
    expect(rssItems[0]?.url).toBe("https://systems.example.org/sqlite-fts5");
    expect(rssItems[0]?.summary).toBe("Practical indexing notes for local-first apps.");
    expect(rssItems[0]?.authors).toEqual(["Jane Doe"]);
    expect(rssItems[0]?.categories).toEqual(["databases"]);
  });

  it("rejects private/loopback and custom-port feed URLs via SSRF/validation guard", async () => {
    await expect(fetchFeedItems("http://127.0.0.1/rss.xml", "rss")).rejects.toThrow(
      LibrarySsrfRejectedError,
    );
    await expect(fetchFeedItems("http://169.254.169.254/latest/meta-data/", "rss")).rejects.toThrow(
      LibrarySsrfRejectedError,
    );
    await expect(fetchFeedItems("http://127.0.0.1:8080/rss.xml", "rss")).rejects.toThrow(
      LibraryValidationError,
    );
  });

  it("persists feeds, enforces explicit auto-AI model, tracks idempotent seen items, and enforces daily AI budget", async () => {
    const dbPath = await makeTempDbPath();
    const fixedNow = () => new Date("2026-11-25T10:00:00.000Z");
    const db = openLibraryDatabase({ dbPath, now: fixedNow });
    try {
      expect(() =>
        db.upsertFeed({
          name: "Bad Auto AI Feed",
          kind: "arxiv",
          url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI",
          autoSummarize: true,
        }),
      ).toThrow(LibraryValidationError);

      const feed = db.upsertFeed({
        name: "arXiv cs.AI",
        kind: "arxiv",
        url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI",
        tags: ["arxiv", "ai"],
        intervalMinutes: 180,
        maxItemsPerRun: 5,
        autoSummarize: true,
        aiInstanceId: "openai",
        aiModel: "gpt-4o-mini",
        dailyAiBudget: 2,
      });

      expect(feed.enabled).toBe(true);
      expect(feed.autoSummarize).toBe(true);
      expect(feed.dailyAiBudget).toBe(2);
      expect(db.listFeeds()).toHaveLength(1);

      const paused = db.setFeedEnabled(feed.id, false);
      expect(paused.enabled).toBe(false);

      expect(db.hasFeedSeenItem(feed.id, "ext-1", "https://arxiv.org/abs/2501.00001v1")).toBe(
        false,
      );
      const entry = db.saveEntry({
        kind: "web",
        title: "Paper 1",
        url: "https://arxiv.org/abs/2501.00001v1",
        body: "Abstract",
      });
      db.markFeedItemSeen(feed.id, "ext-1", entry.url, entry.id);
      expect(db.hasFeedSeenItem(feed.id, "ext-1", entry.url)).toBe(true);
      expect(db.hasFeedSeenItem(feed.id, "different-id", entry.url)).toBe(true);

      // Daily AI budget cap: limit = 2 -> 3rd attempt must be denied
      expect(db.getDailyAiUsageCount()).toBe(0);
      expect(db.consumeDailyAiBudget(2)).toEqual({
        allowed: true,
        usedCount: 1,
        usageDate: "2026-11-25",
      });
      expect(db.consumeDailyAiBudget(2)).toEqual({
        allowed: true,
        usedCount: 2,
        usageDate: "2026-11-25",
      });
      expect(db.consumeDailyAiBudget(2)).toEqual({
        allowed: false,
        usedCount: 2,
        usageDate: "2026-11-25",
      });

      expect(db.deleteFeed(feed.id)).toBe(true);
      expect(db.listFeeds()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
