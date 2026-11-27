// @effect-diagnostics nodeBuiltinImport:off -- Unit tests create fake wkb directories and mock uv scripts on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  WkbBridgeError,
  canonicalizeWkbEndpointUrl,
  detectWkbInstallation,
  inferWkbEntryKind,
  runWkbAnnotate,
  runWkbExport,
  runWkbSubmit,
  runWkbWorkHarvest,
} from "./index.ts";

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

async function makeFakeWkbDir(): Promise<string> {
  const kbDir = await makeTempDir("t3-wkb-dir-");
  await NodeFSP.mkdir(NodePath.join(kbDir, "src", "wkb"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(kbDir, "pyproject.toml"),
    '[project]\nname = "wkb"\n[project.scripts]\nwkb = "wkb.cli:main"\n',
  );
  await NodeFSP.writeFile(NodePath.join(kbDir, "src", "wkb", "cli.py"), "def main(): pass\n");
  return kbDir;
}

async function makeFakeUv(scriptBody: string): Promise<string> {
  const binDir = await makeTempDir("t3-wkb-bin-");
  const uvPath = NodePath.join(binDir, "uv");
  await NodeFSP.writeFile(uvPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return uvPath;
}

describe("wkb-bridge", () => {
  it("detects local, remote, dual, and unavailable modes including syncAvailable", async () => {
    const kbDir = await makeFakeWkbDir();
    const uvPath = await makeFakeUv("exit 0");

    const dual = detectWkbInstallation({
      kbDir,
      uvBinary: uvPath,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
      hasRemoteToken: true,
    });
    expect(dual).toEqual({
      available: true,
      syncAvailable: true,
      mode: "dual",
      uvPath,
      kbDir,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
    });

    const remoteWithToken = detectWkbInstallation({
      kbDir: NodePath.join(kbDir, "nonexistent"),
      uvBinary: uvPath,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
      hasRemoteToken: true,
    });
    expect(remoteWithToken.available).toBe(false);
    expect(remoteWithToken.syncAvailable).toBe(true);
    expect(remoteWithToken.mode).toBe("remote");

    const remoteWithoutToken = detectWkbInstallation({
      kbDir: NodePath.join(kbDir, "nonexistent"),
      uvBinary: uvPath,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
      hasRemoteToken: false,
    });
    expect(remoteWithoutToken.available).toBe(false);
    expect(remoteWithoutToken.syncAvailable).toBe(false);
    expect(remoteWithoutToken.mode).toBe("remote");
  });

  it("infers video, wechat, epub, pdf, and web entry kinds", () => {
    expect(inferWkbEntryKind("https://www.bilibili.com/video/BV1xx411c7mD", false)).toBe("video");
    expect(inferWkbEntryKind("https://youtu.be/dQw4w9WgXcQ", true)).toBe("video");
    expect(inferWkbEntryKind("https://mp.weixin.qq.com/s/abc", false)).toBe("wechat");
    expect(inferWkbEntryKind("/tmp/book.epub", false)).toBe("epub");
    expect(inferWkbEntryKind("https://example.com/paper.pdf", true)).toBe("pdf");
    expect(inferWkbEntryKind("https://example.com/article", false)).toBe("web");
  });

  it("rejects flag injection, credentialed URLs, non-public SSRF hosts, and unapproved local paths", async () => {
    const kbDir = await makeFakeWkbDir();
    const uvPath = await makeFakeUv("exit 0");
    const outDir = await makeTempDir("t3-wkb-out-");

    await expect(
      runWkbExport({ source: "--help", outDir }, { kbDir, uvBinary: uvPath }),
    ).rejects.toThrow(WkbBridgeError);

    await expect(
      runWkbExport(
        { source: "https://user:pass@example.com/x", outDir },
        { kbDir, uvBinary: uvPath },
      ),
    ).rejects.toThrow(WkbBridgeError);

    await expect(
      runWkbExport({ source: "http://127.0.0.1/internal", outDir }, { kbDir, uvBinary: uvPath }),
    ).rejects.toMatchObject({ code: "invalid_source" });

    await expect(
      runWkbExport(
        { source: "https://internal-rebind.example/doc", outDir },
        {
          kbDir,
          uvBinary: uvPath,
          dnsResolver: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_source" });

    await expect(
      runWkbExport({ source: "/etc/passwd", outDir }, { kbDir, uvBinary: uvPath }),
    ).rejects.toThrow(WkbBridgeError);
  });

  it("runs wkb export, scrubs T3CODE_* secrets, enforces outDir containment, and supports PDF output", async () => {
    const kbDir = await makeFakeWkbDir();
    const outDir = await makeTempDir("t3-wkb-out-");
    const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

    const uvPath = await makeFakeUv(`
if [ -n "$T3CODE_SERVER_SECRET" ]; then
  echo "leaked server secret" >&2
  exit 9
fi
OUT=""
PDF=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --pdf) PDF=1; shift ;;
    *) shift ;;
  esac
done
printf "# Bilibili Talk\\n\\n[00:00:05] Hello transcript\\n" > "$OUT/talk.md"
if [ "$PDF" = "1" ]; then
  printf "%%PDF-1.4\\nfake" > "$OUT/talk.pdf"
  printf '{"title":"Bilibili Talk","md":"%s/talk.md","pdf":"%s/talk.pdf","warnings":["whisper fallback"]}\\n' "$OUT" "$OUT"
else
  printf '{"title":"Bilibili Talk","md":"%s/talk.md","pdf":null,"warnings":[]}\\n' "$OUT"
fi
`);

    const exported = await runWkbExport(
      { source: "https://www.bilibili.com/video/BV1test", outDir, pdf: true },
      {
        kbDir,
        uvBinary: uvPath,
        dnsResolver: publicDns,
        env: { T3CODE_SERVER_SECRET: "top-secret", PATH: process.env.PATH },
      },
    );
    expect(exported.title).toBe("Bilibili Talk");
    expect(exported.inferredKind).toBe("video");
    expect(exported.markdown).toContain("Hello transcript");
    expect(exported.pdfPath).toBe(NodePath.join(await NodeFSP.realpath(outDir), "talk.pdf"));
    expect(exported.warnings).toEqual(["whisper fallback"]);

    // Escape attempt outside outDir is rejected
    const outsideDir = await makeTempDir("t3-wkb-outside-");
    const outsideMd = NodePath.join(outsideDir, "escape.md");
    await NodeFSP.writeFile(outsideMd, "secret");
    const evilUv = await makeFakeUv(
      `printf '{"title":"Escape","md":"${outsideMd}","pdf":null,"warnings":[]}\\n'`,
    );
    await expect(
      runWkbExport(
        { source: "https://example.com/post", outDir },
        { kbDir, uvBinary: evilUv, dnsResolver: publicDns },
      ),
    ).rejects.toThrow(WkbBridgeError);
  });

  it("aligns local CLI 'wkb harvest' and adapts remote MCP between brain_submit/brain_ingest and work_harvest/work_submit", async () => {
    const kbDir = await makeFakeWkbDir();
    const uvPath = await makeFakeUv(`printf "Harvested args: %s\\n" "$*"`);

    const localResult = await runWkbWorkHarvest({ project: "wagent" }, { kbDir, uvBinary: uvPath });
    expect(localResult.mode).toBe("local");
    expect(localResult.project).toBe("wagent");
    expect(localResult.summary).toContain("wkb harvest wagent");
    expect(localResult.summary).not.toContain("work harvest");

    const methods: string[] = [];
    const makeRemoteMcpFetch = (advertisedTools: ReadonlyArray<string>): typeof fetch => {
      return async (_url, init) => {
        const httpMethod = String(init?.method ?? "POST").toUpperCase();
        if (httpMethod === "DELETE") {
          methods.push("DELETE");
          return new Response(null, { status: 204 });
        }
        const parsed = JSON.parse(String(init?.body ?? "{}")) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        methods.push(parsed.method);
        if (parsed.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (parsed.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }), {
            status: 200,
            headers: { "mcp-session-id": "sess-1" },
          });
        }
        if (parsed.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { tools: advertisedTools.map((name) => ({ name })) },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              content: [{ text: `Executed ${String(parsed.params?.name)}` }],
            },
          }),
          { status: 200 },
        );
      };
    };

    // Remote-mode wkb server advertises brain_submit + work_submit
    const submitRes = await runWkbSubmit(
      {
        title: "Attention Is All You Need",
        url: "https://arxiv.org/abs/1706.03762",
        text: "Transformer architecture replaces recurrence with self-attention.",
        note: "Foundational sequence modeling paper.",
      },
      {
        remoteUrl: "https://kb.example.invalid/mcp",
        remoteToken: "secret-token",
        fetchImpl: makeRemoteMcpFetch(["brain_annotate", "brain_submit", "work_submit"]),
      },
    );
    expect(submitRes.mode).toBe("remote");
    expect(submitRes.summary).toBe("Executed brain_submit");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("DELETE");

    // Pure remote work_submit succeeds when report + files are supplied
    const remoteWorkSubmit = await runWkbWorkHarvest(
      {
        project: "wagent",
        report: "## Progress\nShipped M3",
        files: [{ name: "overview", content: "# Overview\nUpdated" }],
      },
      {
        remoteUrl: "https://kb.example.invalid/mcp",
        remoteToken: "secret-token",
        fetchImpl: makeRemoteMcpFetch(["brain_submit", "work_submit"]),
      },
    );
    expect(remoteWorkSubmit.mode).toBe("remote");
    expect(remoteWorkSubmit.summary).toBe("Executed work_submit");

    // Dual mode falls back to local 'wkb harvest' when remote MCP only exposes submit-only 'work_submit'
    const dualHarvest = await runWkbWorkHarvest(
      { project: "wagent" },
      {
        kbDir,
        uvBinary: uvPath,
        remoteUrl: "https://kb.example.invalid/mcp",
        remoteToken: "secret-token",
        fetchImpl: makeRemoteMcpFetch(["brain_submit", "work_submit"]),
      },
    );
    expect(dualHarvest.mode).toBe("local");
    expect(dualHarvest.summary).toContain("wkb harvest wagent");

    // Local-mode MCP server advertising work_harvest runs remotely
    const remoteHarvest = await runWkbWorkHarvest(
      { project: "wagent" },
      {
        remoteUrl: "https://kb.example.invalid/mcp",
        remoteToken: "secret-token",
        fetchImpl: makeRemoteMcpFetch(["work_harvest"]),
      },
    );
    expect(remoteHarvest.mode).toBe("remote");
    expect(remoteHarvest.summary).toBe("Executed work_harvest");

    await expect(
      runWkbWorkHarvest({ project: "../escape" }, { kbDir, uvBinary: uvPath }),
    ).rejects.toThrow(WkbBridgeError);
  });

  it("rejects empty 204 responses, mismatched JSON-RPC ids, and enforces hard remote MCP timeouts", async () => {
    await expect(
      runWkbAnnotate(
        {
          sourceId: "src-1",
          annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
        },
        {
          remoteUrl: "https://kb.example.invalid/mcp",
          remoteToken: "token",
          fetchImpl: async (_url, init) => {
            const req = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
            if (req.method === "initialize") {
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
                status: 200,
              });
            }
            return new Response(null, { status: 204 });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });

    await expect(
      runWkbAnnotate(
        {
          sourceId: "src-1",
          annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
        },
        {
          remoteUrl: "https://kb.example.invalid/mcp",
          remoteToken: "token",
          fetchImpl: async (_url, init) => {
            const req = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
            if (req.method === "initialize") {
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
                status: 200,
              });
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 999,
                result: { content: [{ text: "wrong id" }] },
              }),
              { status: 200 },
            );
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });

    await expect(
      runWkbAnnotate(
        {
          sourceId: "src-1",
          annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
        },
        {
          remoteUrl: "https://kb.example.invalid/mcp",
          remoteToken: "token",
          timeoutMs: 40,
          fetchImpl: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Timed out", "AbortError"));
              });
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    // Real wkb guarded() returns business failure text with HTTP 200 without setting isError
    await expect(
      runWkbSubmit(
        { title: "Bad Submit", text: "body" },
        {
          remoteUrl: "https://kb.example.invalid/mcp",
          remoteToken: "token",
          fetchImpl: async (_url, init) => {
            if (String(init?.method ?? "POST").toUpperCase() === "DELETE") {
              return new Response(null, { status: 204 });
            }
            const req = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
            if (req.method === "notifications/initialized") {
              return new Response(null, { status: 202 });
            }
            if (req.method === "initialize") {
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
                status: 200,
              });
            }
            if (req.method === "tools/list") {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: { tools: [{ name: "brain_submit" }] },
                }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ text: "提交没有通过检查：标题重复" }] },
              }),
              { status: 200 },
            );
          },
        },
      ),
    ).rejects.toMatchObject({ code: "process_failed" });

    // Real remote wkb background enqueue returns queued receipt -> syncedCount=0, queued=true
    const queuedAnnotate = await runWkbAnnotate(
      {
        sourceId: "src-1",
        annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
      },
      {
        remoteUrl: "https://kb.example.invalid/mcp",
        remoteToken: "token",
        fetchImpl: async (_url, init) => {
          if (String(init?.method ?? "POST").toUpperCase() === "DELETE") {
            return new Response(null, { status: 204 });
          }
          const req = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
          if (req.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          if (req.method === "initialize") {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
              status: 200,
            });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                content: [{ text: "已收到，正在后台处理（任务 job-42），稍后通过日志查看结果。" }],
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(queuedAnnotate.queued).toBe(true);
    expect(queuedAnnotate.syncedCount).toBe(0);

    // brain_ingest intent rejection ("已拒绝：...") is treated as failure, and broken initialize still sends DELETE
    let sawDeleteOnBrokenInit = false;
    await expect(
      runWkbAnnotate(
        {
          sourceId: "src-1",
          annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
        },
        {
          remoteUrl: "https://kb.example.invalid/mcp",
          remoteToken: "token",
          fetchImpl: async (_url, init) => {
            if (String(init?.method ?? "POST").toUpperCase() === "DELETE") {
              sawDeleteOnBrokenInit = true;
              return new Response(null, { status: 204 });
            }
            return new Response("not-json", {
              status: 200,
              headers: { "mcp-session-id": "sess-broken-init" },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });
    expect(sawDeleteOnBrokenInit).toBe(true);

    // Canonical endpoint URL preserves trailing slash in query values and distinguishes /kb from /kb/
    expect(canonicalizeWkbEndpointUrl("https://kb.example.invalid/mcp?tenant=fixture/")).toBe(
      "https://kb.example.invalid/mcp?tenant=fixture/",
    );
    expect(canonicalizeWkbEndpointUrl("https://kb.example.invalid/kb")).toBe(
      "https://kb.example.invalid/kb",
    );
    expect(canonicalizeWkbEndpointUrl("https://kb.example.invalid/kb/")).toBe(
      "https://kb.example.invalid/kb/",
    );
    const detectedTenantSlash = detectWkbInstallation({
      remoteUrl: "https://kb.example.invalid/mcp?tenant=fixture/",
      hasRemoteToken: true,
    });
    expect(detectedTenantSlash.remoteUrl).toBe("https://kb.example.invalid/mcp?tenant=fixture/");
    const seenUrls: string[] = [];
    await runWkbAnnotate(
      {
        sourceId: "src-tenant",
        annotations: [{ id: "a1", kind: "重点", text: "Quote", location: { page: 1 } }],
      },
      {
        remoteUrl: detectedTenantSlash.remoteUrl,
        remoteToken: "token",
        fetchImpl: async (url, init) => {
          seenUrls.push(String(url));
          if (String(init?.method ?? "POST").toUpperCase() === "DELETE") {
            return new Response(null, { status: 204 });
          }
          const req = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
          if (req.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          if (req.method === "initialize") {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
              status: 200,
              headers: { "mcp-session-id": "sess-tenant" },
            });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { content: [{ text: "ok" }] },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(seenUrls.every((u) => u === "https://kb.example.invalid/mcp?tenant=fixture/")).toBe(
      true,
    );
  });
});
