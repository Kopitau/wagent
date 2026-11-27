// @effect-diagnostics nodeBuiltinImport:off -- Unit tests manage temp directories and synthetic PDF fixtures with Node builtins.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  LibrarySsrfRejectedError,
  LibraryUploadTooLargeError,
  LibraryValidationError,
} from "./errors.ts";
import {
  extractArticleFromHtml,
  extractPdfPagesFromFile,
  fetchWebArticle,
  isGloballyRoutableAddress,
  openLibraryDatabase,
  publishStagedPdfBlob,
  recoverAndSweepBlobs,
  stagePdfBlobFromStream,
} from "./server/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

function buildMinimalPdf(
  pages: ReadonlyArray<{ readonly text?: string; readonly cjkHex?: string }>,
  title?: string,
): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];

  // 1: Catalog, 2: Pages, 3: Helvetica font, 4: Type0 CJK font (Identity-H + ToUnicode)
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(""); // placeholder for Pages
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // Object 4: Type0 CJK font using ToUnicode CMap for deterministic CJK text extraction
  objects.push(
    "<< /Type /Font /Subtype /Type0 /BaseFont /FakeCJK /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
  );
  objects.push(
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FakeCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
  );
  const cmapStream = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "4 beginbfchar",
    "<0001> <91CF>", // 量
    "<0002> <5B50>", // 子
    "<0003> <7814>", // 研
    "<0004> <7A76>", // 究
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  objects.push(
    `<< /Length ${Buffer.byteLength(cmapStream, "ascii")} >>\nstream\n${cmapStream}\nendstream`,
  );

  for (const page of pages) {
    const pageObjId = objects.length + 1;
    const contentObjId = objects.length + 2;
    pageIds.push(pageObjId);
    const ops: string[] = [];
    if (page.text) {
      ops.push(`BT /F1 18 Tf 30 700 Td (${page.text}) Tj ET`);
    }
    if (page.cjkHex) {
      ops.push(`BT /F2 18 Tf 30 660 Td <${page.cjkHex}> Tj ET`);
    }
    const content = ops.join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    );
  }

  let infoRef = "";
  if (title) {
    const infoId = objects.length + 1;
    objects.push(`<< /Title (${title}) >>`);
    infoRef = ` /Info ${infoId} 0 R`;
  }

  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "latin1"));
    source += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "latin1");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source, "latin1");
}

async function* chunkBuffer(buffer: Buffer, chunkSize: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.byteLength));
  }
}

describe("M1b blobs, PDF extraction, SSRF web fetch, and MCP read", () => {
  it("enforces exact streaming byte limits, cleans up temp files, and publishes exclusively", async () => {
    const dir = await makeTempDir("t3-lib-blobs-");
    const blobsDir = NodePath.join(dir, "blobs");
    const pdfBytes = buildMinimalPdf([{ text: "Hello Blob" }]);

    // Exact boundary passes
    const exactStaged = await stagePdfBlobFromStream({
      blobsDir,
      chunks: chunkBuffer(pdfBytes, 32),
      maxBytes: pdfBytes.byteLength,
    });
    expect(exactStaged.bytes).toBe(pdfBytes.byteLength);
    const firstPublish = await publishStagedPdfBlob({ blobsDir, staged: exactStaged });
    expect(firstPublish.reused).toBe(false);
    expect(NodeFS.existsSync(exactStaged.tmpPath)).toBe(false);

    // Duplicate upload reuses existing blob without replacing
    const duplicateStaged = await stagePdfBlobFromStream({
      blobsDir,
      chunks: chunkBuffer(pdfBytes, 64),
      maxBytes: pdfBytes.byteLength,
    });
    const secondPublish = await publishStagedPdfBlob({ blobsDir, staged: duplicateStaged });
    expect(secondPublish.reused).toBe(true);
    expect(secondPublish.sha256).toBe(firstPublish.sha256);
    expect(NodeFS.existsSync(duplicateStaged.tmpPath)).toBe(false);

    // Exceeding maxBytes by 1 byte fails and cleans .tmp immediately
    await expect(
      stagePdfBlobFromStream({
        blobsDir,
        chunks: chunkBuffer(pdfBytes, 32),
        maxBytes: pdfBytes.byteLength - 1,
      }),
    ).rejects.toThrow(LibraryUploadTooLargeError);

    // Invalid magic header fails and cleans .tmp immediately
    await expect(
      stagePdfBlobFromStream({
        blobsDir,
        chunks: chunkBuffer(Buffer.from("not a pdf document", "utf8"), 8),
        maxBytes: 1024,
      }),
    ).rejects.toThrow(LibraryValidationError);

    // Aborted stream fails and cleans .tmp immediately
    const abortController = new AbortController();
    abortController.abort();
    await expect(
      stagePdfBlobFromStream({
        blobsDir,
        chunks: chunkBuffer(pdfBytes, 16),
        signal: abortController.signal,
      }),
    ).rejects.toThrow(LibraryValidationError);

    const remainingFiles = await NodeFSP.readdir(blobsDir);
    expect(remainingFiles).toEqual([`${firstPublish.sha256}.pdf`]);
  });

  it("performs delayed recoverable GC, tolerates Windows lock errors, and reports missing blobs", async () => {
    const dir = await makeTempDir("t3-lib-gc-");
    const blobsDir = NodePath.join(dir, "blobs");
    await NodeFSP.mkdir(blobsDir, { recursive: true });

    const activeSha = "a".repeat(64);
    const missingSha = "b".repeat(64);
    const recentOrphanSha = "c".repeat(64);
    const expiredOrphanSha = "d".repeat(64);
    const lockedOrphanSha = "e".repeat(64);

    await NodeFSP.writeFile(NodePath.join(blobsDir, `${activeSha}.pdf`), "%PDF-1.4 active");
    await NodeFSP.writeFile(NodePath.join(blobsDir, `${recentOrphanSha}.pdf`), "%PDF-1.4 recent");
    await NodeFSP.writeFile(NodePath.join(blobsDir, `${expiredOrphanSha}.pdf`), "%PDF-1.4 expired");
    await NodeFSP.writeFile(NodePath.join(blobsDir, `${lockedOrphanSha}.pdf`), "%PDF-1.4 locked");
    await NodeFSP.writeFile(NodePath.join(blobsDir, ".tmp-stale-123"), "partial");

    const nowMs = 1_700_000_000_000;
    const oldTimeSec = (nowMs - 20 * 60_000) / 1000;
    await NodeFSP.utimes(
      NodePath.join(blobsDir, `${expiredOrphanSha}.pdf`),
      oldTimeSec,
      oldTimeSec,
    );
    await NodeFSP.utimes(NodePath.join(blobsDir, `${lockedOrphanSha}.pdf`), oldTimeSec, oldTimeSec);
    await NodeFSP.utimes(NodePath.join(blobsDir, ".tmp-stale-123"), oldTimeSec, oldTimeSec);

    const report = await recoverAndSweepBlobs({
      blobsDir,
      referencedSha256s: new Set([activeSha, missingSha]),
      countBlobReferences: (sha) => (sha === activeSha ? 1 : 0),
      nowMs,
      orphanGraceMs: 10 * 60_000,
      tempGraceMs: 10 * 60_000,
      unlinkFn: async (filePath) => {
        if (filePath.endsWith(`${lockedOrphanSha}.pdf`)) {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        }
        await NodeFSP.unlink(filePath);
      },
    });

    expect(report).toEqual({
      removedTempFiles: 1,
      removedOrphanBlobs: 1,
      deferredLockedBlobs: 1,
      missingBlobSha256s: [missingSha],
    });
    expect(NodeFS.existsSync(NodePath.join(blobsDir, `${activeSha}.pdf`))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(blobsDir, `${recentOrphanSha}.pdf`))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(blobsDir, `${expiredOrphanSha}.pdf`))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(blobsDir, `${lockedOrphanSha}.pdf`))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(blobsDir, ".tmp-stale-123"))).toBe(false);
  });

  it("extracts English and Chinese PDF pages, preserves true pageCount, and marks empty/truncated/skipped pages", async () => {
    const dir = await makeTempDir("t3-lib-pdf-");
    const pdfPath = NodePath.join(dir, "sample.pdf");
    const pdfBytes = buildMinimalPdf(
      [
        { text: "Quantum Architecture Overview", cjkHex: "0001000200030004" },
        {},
        { text: "Third page appendix with details" },
      ],
      "Bilingual Paper",
    );
    await NodeFSP.writeFile(pdfPath, pdfBytes);

    const full = await extractPdfPagesFromFile(pdfPath);
    expect(full.pageCount).toBe(3);
    expect(full.title).toBe("Bilingual Paper");
    expect(full.pages).toHaveLength(3);
    expect(full.pages[0]?.physicalPage).toBe(1);
    expect(full.pages[0]?.extractionStatus).toBe("ok");
    expect(full.pages[0]?.text).toContain("Quantum Architecture Overview");
    expect(full.pages[0]?.text.replace(/\s+/gu, "")).toContain("量子研究");
    expect(full.pages[1]).toEqual({
      physicalPage: 2,
      text: "",
      extractionStatus: "empty_scan",
    });
    expect(full.pages[2]?.physicalPage).toBe(3);
    expect(full.pages[2]?.extractionStatus).toBe("ok");
    expect(full.pages[2]?.text).toContain("Third page appendix");

    // Budget exhaustion keeps real pageCount and marks truncated + skipped
    const bounded = await extractPdfPagesFromFile(pdfPath, { maxTotalChars: 12 });
    expect(bounded.pageCount).toBe(3);
    expect(bounded.pages[0]?.extractionStatus).toBe("truncated");
    expect(bounded.pages[0]?.text.length).toBe(12);
    expect(bounded.pages[1]?.extractionStatus).toBe("skipped");
    expect(bounded.pages[2]?.extractionStatus).toBe("skipped");
  });

  it("enforces hop-by-hop DNS-pinned SSRF protection and extracts web/WeChat HTML", async () => {
    expect(isGloballyRoutableAddress("127.0.0.1")).toBe(false);
    expect(isGloballyRoutableAddress("10.0.0.5")).toBe(false);
    expect(isGloballyRoutableAddress("169.254.169.254")).toBe(false);
    expect(isGloballyRoutableAddress("192.168.1.1")).toBe(false);
    expect(isGloballyRoutableAddress("::1")).toBe(false);
    expect(isGloballyRoutableAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isGloballyRoutableAddress("93.184.216.34")).toBe(true);
    expect(isGloballyRoutableAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);

    // Direct loopback IP rejected
    await expect(fetchWebArticle("http://127.0.0.1/secret")).rejects.toThrow(
      LibrarySsrfRejectedError,
    );

    // Hostname resolving to private IP rejected
    await expect(
      fetchWebArticle("https://internal.example.test/doc", {
        dnsResolver: async () => [{ address: "10.1.2.3", family: 4 }],
      }),
    ).rejects.toThrow(LibrarySsrfRejectedError);

    // Public hop redirecting to private IP rejected at second hop
    await expect(
      fetchWebArticle("https://public.example.test/start", {
        dnsResolver: async (host) =>
          host === "public.example.test"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "169.254.169.254", family: 4 }],
        requestHop: async () => ({
          statusCode: 302,
          headers: { location: "https://metadata.internal.test/latest" },
          body: Buffer.alloc(0),
        }),
      }),
    ).rejects.toThrow(LibrarySsrfRejectedError);

    // Public WeChat article succeeds and extracts #js_content
    const article = await fetchWebArticle("https://mp.weixin.qq.com/s/test-article", {
      dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
      requestHop: async ({ pinnedAddress }) => {
        expect(pinnedAddress.address).toBe("93.184.216.34");
        return {
          statusCode: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: Buffer.from(
            `<html><head><title>Ignored</title></head><body>
              <h1 id="activity-name">深度解读大模型推理</h1>
              <div id="js_content"><p>第一段核心结论。</p><p>第二段实验数据。</p></div>
            </body></html>`,
            "utf8",
          ),
        };
      },
    });
    expect(article.kind).toBe("wechat");
    expect(article.title).toBe("深度解读大模型推理");
    expect(article.body).toContain("第一段核心结论");
    expect(article.body).toContain("第二段实验数据");

    // WeChat captcha detection
    const captcha = extractArticleFromHtml(
      "<html><body>环境异常 wappoc_appmsgcaptcha</body></html>",
      "https://mp.weixin.qq.com/s/blocked",
    );
    expect(captcha.wechatBlocked).toBe(true);
  });

  it("reads bounded 1-based physical page slices with untrusted data framing for MCP", () => {
    const db = openLibraryDatabase({ dbPath: ":memory:" });
    try {
      const saved = db.saveEntry({
        kind: "pdf",
        title: "Paged Paper",
        body: "Summary body",
        note: "Personal takeaway",
        pageCount: 4,
        blobSha256: "f".repeat(64),
        blobBytes: 1234,
        pages: [
          { physicalPage: 1, text: "Page one introduction.", extractionStatus: "ok" },
          { physicalPage: 2, text: "Page two methodology.", extractionStatus: "ok" },
          { physicalPage: 3, text: "Page three experiments.", extractionStatus: "ok" },
          { physicalPage: 4, text: "", extractionStatus: "empty_scan" },
        ],
      });

      expect(db.countBlobReferences("f".repeat(64))).toBe(1);
      expect([...db.listReferencedBlobSha256s()]).toEqual(["f".repeat(64)]);

      const slice = db.readEntryForMcp({
        id: saved.id,
        pageStart: 2,
        pageEnd: 3,
        maxChars: 1000,
      });
      expect(slice.pageCount).toBe(4);
      expect(slice.pages.map((page) => page.physicalPage)).toEqual([2, 3]);
      expect(slice.note).toBe("Personal takeaway");
      expect(slice.untrustedContentNotice).toContain("UNTRUSTED EXTERNAL REFERENCE DATA");
      expect(slice.truncated).toBe(false);
    } finally {
      db.close();
    }
  });
});
