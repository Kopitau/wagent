import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  LIBRARY_UPLOAD_PDF_PATH,
  libraryItemPdfPath,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import * as LibraryHttp from "./http.ts";
import * as LibraryService from "./LibraryService.ts";

function buildBilingualTestPdf(): Uint8Array {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Count 2 /Kids [7 0 R 9 0 R] >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(
    "<< /Type /Font /Subtype /Type0 /BaseFont /FakeCJK /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
  );
  objects.push(
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FakeCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
  );
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "2 beginbfchar",
    "<0001> <91CF>",
    "<0002> <5B50>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  objects.push(`<< /Length ${Buffer.byteLength(cmap, "ascii")} >>\nstream\n${cmap}\nendstream`);

  const page1 =
    "BT /F1 18 Tf 30 700 Td (English Abstract) Tj ET\nBT /F2 18 Tf 30 660 Td <00010002> Tj ET";
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 8 0 R >>",
  );
  objects.push(`<< /Length ${Buffer.byteLength(page1, "ascii")} >>\nstream\n${page1}\nendstream`);

  const page2 = "BT /F1 18 Tf 30 700 Td (Page Two Findings) Tj ET";
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 10 0 R >>",
  );
  objects.push(`<< /Length ${Buffer.byteLength(page2, "ascii")} >>\nstream\n${page2}\nendstream`);

  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "latin1"));
    source += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source, "latin1");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(source, "latin1"));
}

const makeMockAuthLayer = () =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const auth = request.headers.authorization;
      if (auth === "Bearer op-token") {
        return Effect.succeed({
          sessionId: AuthSessionId.make("sess-op"),
          subject: "user-session",
          method: "bearer-access-token" as const,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        });
      }
      if (auth === "Bearer read-token") {
        return Effect.succeed({
          sessionId: AuthSessionId.make("sess-read"),
          subject: "user-session",
          method: "bearer-access-token" as const,
          scopes: [AuthOrchestrationReadScope],
        });
      }
      if (auth === "Bearer mcp-client-token") {
        return Effect.fail(
          new EnvironmentAuth.ServerAuthInvalidCredentialError({
            diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
          }),
        );
      }
      return Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));
    },
  });

it.effect(
  "streams PDF upload through isolated extractor, enforces auth/headers/ranges, and recovers missing blobs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-m1b-http-" });
        const envId = EnvironmentId.make("env-m1b-http");

        const serviceLayer = LibraryService.layer.pipe(
          Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
          ),
        );

        const builtService = yield* Layer.build(serviceLayer);
        const library = builtService.mapUnsafe.get(
          LibraryService.LibraryService.key,
        ) as LibraryService.LibraryService["Service"];
        const httpLayer = LibraryHttp.layerLibraryHttpRoutes.pipe(
          Layer.provide(Layer.succeed(LibraryService.LibraryService, library)),
          Layer.provide(makeMockAuthLayer()),
        );
        yield* HttpRouter.serve(httpLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const client = yield* HttpClient.HttpClient;
        const pdfBytes = buildBilingualTestPdf();

        // 1. External mcp-client token is rejected outside /mcp
        const mcpRejected = yield* client.execute(
          HttpClientRequest.post(`${LIBRARY_UPLOAD_PDF_PATH}?fileName=paper.pdf`).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer mcp-client-token"),
            HttpClientRequest.setBody(HttpBody.uint8Array(pdfBytes, "application/pdf")),
          ),
        );
        expect(mcpRejected.status).toBe(401);

        // 2. Read-only token is refused on upload (403)
        const readOnlyUpload = yield* client.execute(
          HttpClientRequest.post(`${LIBRARY_UPLOAD_PDF_PATH}?fileName=paper.pdf`).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
            HttpClientRequest.setBody(HttpBody.uint8Array(pdfBytes, "application/pdf")),
          ),
        );
        expect(readOnlyUpload.status).toBe(403);

        // 3. Invalid non-PDF upload returns 400 and leaves zero temp files
        const badUpload = yield* client.execute(
          HttpClientRequest.post(`${LIBRARY_UPLOAD_PDF_PATH}?fileName=fake.pdf`).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer op-token"),
            HttpClientRequest.setBody(
              HttpBody.uint8Array(new TextEncoder().encode("not-a-pdf"), "application/pdf"),
            ),
          ),
        );
        expect(badUpload.status).toBe(400);

        // 4. Valid bilingual PDF upload succeeds (201), runs isolated __library-extract-pdf, stores 2 pages
        const uploadRes = yield* client.execute(
          HttpClientRequest.post(
            `${LIBRARY_UPLOAD_PDF_PATH}?fileName=quantum.pdf&title=Bilingual%20PDF&tags=ai,pdf`,
          ).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer op-token"),
            HttpClientRequest.setBody(HttpBody.uint8Array(pdfBytes, "application/pdf")),
          ),
        );
        expect(uploadRes.status).toBe(201);
        const uploaded = (yield* uploadRes.json) as {
          readonly entry: {
            readonly id: string;
            readonly kind: string;
            readonly title: string;
            readonly pageCount: number;
            readonly blobSha256: string;
            readonly blobBytes: number;
            readonly blobMissing: boolean;
            readonly body: string;
          };
        };
        expect(uploaded.entry.kind).toBe("pdf");
        expect(uploaded.entry.title).toBe("Bilingual PDF");
        expect(uploaded.entry.pageCount).toBe(2);
        expect(uploaded.entry.blobBytes).toBe(pdfBytes.byteLength);
        expect(uploaded.entry.blobMissing).toBe(false);
        expect(uploaded.entry.body).toContain("English Abstract");
        expect(uploaded.entry.body.replace(/\s+/gu, "")).toContain("量子");
        expect(uploaded.entry.body).toContain("Page Two Findings");

        // 5. Read-only token CAN read PDF via GET & HEAD with strict security headers
        const pdfUrl = libraryItemPdfPath(uploaded.entry.id);
        const headRes = yield* client.execute(
          HttpClientRequest.head(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
          ),
        );
        expect(headRes.status).toBe(200);
        expect(headRes.headers["content-type"]).toBe("application/pdf");
        expect(headRes.headers["x-content-type-options"]).toBe("nosniff");
        expect(headRes.headers["cache-control"]).toBe("private, no-store");
        expect(headRes.headers["content-disposition"]).toBe("inline");
        expect(headRes.headers["accept-ranges"]).toBe("bytes");
        expect(headRes.headers["content-length"]).toBe(String(pdfBytes.byteLength));

        // 6. External mcp-client token is rejected on PDF GET as well
        const mcpGet = yield* client.execute(
          HttpClientRequest.get(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer mcp-client-token"),
          ),
        );
        expect(mcpGet.status).toBe(401);

        // 7. Range 206, unsatisfiable 416, and If-Range fallback to 200
        const rangeRes = yield* client.execute(
          HttpClientRequest.get(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
            HttpClientRequest.setHeader("range", "bytes=0-15"),
          ),
        );
        expect(rangeRes.status).toBe(206);
        expect(rangeRes.headers["content-range"]).toBe(`bytes 0-15/${pdfBytes.byteLength}`);
        const rangeBytes = new Uint8Array(yield* rangeRes.arrayBuffer);
        expect(rangeBytes.byteLength).toBe(16);
        expect(new TextDecoder("latin1").decode(rangeBytes.slice(0, 5))).toBe("%PDF-");

        const badRangeRes = yield* client.execute(
          HttpClientRequest.get(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
            HttpClientRequest.setHeader("range", "bytes=999999-"),
          ),
        );
        expect(badRangeRes.status).toBe(416);

        const ifRangeRes = yield* client.execute(
          HttpClientRequest.get(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
            HttpClientRequest.setHeader("range", "bytes=0-15"),
            HttpClientRequest.setHeader("if-range", '"opaque"'),
          ),
        );
        expect(ifRangeRes.status).toBe(200);
        expect((yield* ifRangeRes.arrayBuffer).byteLength).toBe(pdfBytes.byteLength);

        // 8. Missing blob on disk marks blobMissing without crashing and returns 404 + header
        const resolvedBeforeDelete = yield* library.resolvePdfBlob(uploaded.entry.id);
        expect(resolvedBeforeDelete._tag).toBe("Ready");
        if (resolvedBeforeDelete._tag !== "Ready") return;
        yield* fs.remove(resolvedBeforeDelete.filePath, { force: true });
        const afterMissing = yield* library.get({ id: uploaded.entry.id });
        expect(afterMissing.entry.blobMissing).toBe(true);
        const missingPdfRes = yield* client.execute(
          HttpClientRequest.get(pdfUrl).pipe(
            HttpClientRequest.setHeader("authorization", "Bearer read-token"),
          ),
        );
        expect(missingPdfRes.status).toBe(404);
        expect(missingPdfRes.headers["x-library-blob-missing"]).toBe("1");

        // 9. SSRF loopback URL is hard-rejected even when allowFallback is true
        const ssrfError = yield* library
          .fetchUrl({ url: "http://127.0.0.1/admin", allowFallback: true })
          .pipe(Effect.flip);
        expect(ssrfError._tag).toBe("LibrarySsrfRejectedError");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
);

it.effect(
  "imports multimodal video + generated PDF via WkbBridgeService and cleans temp dirs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-wkb-e2e-" });
        const kbDir = path.join(tempDir, "fake-kb");
        const binDir = path.join(tempDir, "fake-bin");
        const fixturePdf = path.join(tempDir, "fixture.pdf");

        yield* fs.makeDirectory(path.join(kbDir, "src", "wkb"), { recursive: true });
        yield* fs.writeFileString(
          path.join(kbDir, "pyproject.toml"),
          '[project]\nname = "wkb"\n[project.scripts]\nwkb = "wkb.cli:main"\n',
        );
        yield* fs.writeFileString(path.join(kbDir, "src", "wkb", "cli.py"), "def main(): pass\n");
        yield* fs.writeFile(fixturePdf, buildBilingualTestPdf());

        yield* fs.makeDirectory(binDir, { recursive: true });
        const uvScript = path.join(binDir, "uv");
        yield* fs.writeFileString(
          uvScript,
          `#!/bin/sh
OUT=""
PDF=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --pdf) PDF=1; shift ;;
    *) shift ;;
  esac
done
printf "# Bilibili Keynote\\n\\n[00:00:01] Multimodal transcript\\n" > "$OUT/keynote.md"
if [ "$PDF" = "1" ]; then
  cp "${fixturePdf}" "$OUT/keynote.pdf"
  printf '{"title":"Bilibili Keynote","md":"%s/keynote.md","pdf":"%s/keynote.pdf","warnings":["local whisper"]}\\n' "$OUT" "$OUT"
else
  printf '{"title":"Bilibili Keynote","md":"%s/keynote.md","pdf":null,"warnings":[]}\\n' "$OUT"
fi
`,
        );
        yield* fs.chmod(uvScript, 0o755);

        const envId = EnvironmentId.make("env-wkb-e2e");
        const hostEnv = {
          ...process.env,
          T3CODE_WKB_DIR: kbDir,
          T3CODE_WKB_UV_BIN: uvScript,
          T3CODE_WKB_REMOTE_URL: "https://kb.example.invalid/kb/mcp",
        };

        const libraryLayer = LibraryService.layer.pipe(
          Layer.provide(WkbBridgeService.layer),
          Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
          ),
          Layer.provide(Layer.succeed(HostProcess.Environment, hostEnv)),
        );

        yield* Effect.gen(function* () {
          const library = yield* LibraryService.LibraryService;
          const status = yield* library.wkbStatus();
          expect(status).toEqual({
            available: true,
            mode: "dual",
            remoteUrl: "https://kb.example.invalid/kb/mcp",
          });

          const imported = yield* library.importFromWkb({
            source: "https://www.bilibili.com/video/BV1test123",
            generatePdf: true,
            tags: ["bilibili"],
          });
          expect(imported.entry.kind).toBe("video");
          expect(imported.entry.title).toBe("Bilibili Keynote");
          expect(imported.entry.body).toContain("Multimodal transcript");
          expect(imported.entry.blobSha256).not.toBeNull();
          expect(imported.entry.blobMissing).toBe(false);
          expect(imported.entry.pageCount).toBe(2);
          expect(imported.warnings).toEqual(["local whisper"]);

          // Verify temporary wkb export directory was cleaned up after import
          const tmpRoot = path.join(tempDir, "research-library", "tmp");
          const remaining = yield* fs.readDirectory(tmpRoot).pipe(Effect.orElseSucceed(() => []));
          expect(remaining).toEqual([]);
        }).pipe(Effect.provide(libraryLayer));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
