// @effect-diagnostics nodeBuiltinImport:off -- Unit tests create fake wkb directories and mock uv scripts on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WkbBridgeError, detectWkbInstallation, inferWkbEntryKind, runWkbExport } from "./index.ts";

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
  it("detects local, remote, dual, and unavailable modes", async () => {
    const kbDir = await makeFakeWkbDir();
    const uvPath = await makeFakeUv("exit 0");

    const dual = detectWkbInstallation({
      kbDir,
      uvBinary: uvPath,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
    });
    expect(dual).toEqual({
      available: true,
      mode: "dual",
      uvPath,
      kbDir,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
    });

    const remoteOnly = detectWkbInstallation({
      kbDir: NodePath.join(kbDir, "nonexistent"),
      uvBinary: uvPath,
      remoteUrl: "https://kb.example.invalid/kb/mcp",
    });
    expect(remoteOnly.available).toBe(false);
    expect(remoteOnly.mode).toBe("remote");
  });

  it("infers video, wechat, epub, pdf, and web entry kinds", () => {
    expect(inferWkbEntryKind("https://www.bilibili.com/video/BV1xx411c7mD", false)).toBe("video");
    expect(inferWkbEntryKind("https://youtu.be/dQw4w9WgXcQ", true)).toBe("video");
    expect(inferWkbEntryKind("https://mp.weixin.qq.com/s/abc", false)).toBe("wechat");
    expect(inferWkbEntryKind("/tmp/book.epub", false)).toBe("epub");
    expect(inferWkbEntryKind("https://example.com/paper.pdf", true)).toBe("pdf");
    expect(inferWkbEntryKind("https://example.com/article", false)).toBe("web");
  });

  it("rejects flag injection, credentialed URLs, and unapproved local paths", async () => {
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
      runWkbExport({ source: "/etc/passwd", outDir }, { kbDir, uvBinary: uvPath }),
    ).rejects.toThrow(WkbBridgeError);
  });

  it("runs wkb export, parses JSON output, enforces outDir containment, and supports PDF output", async () => {
    const kbDir = await makeFakeWkbDir();
    const outDir = await makeTempDir("t3-wkb-out-");

    const uvPath = await makeFakeUv(`
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
      { kbDir, uvBinary: uvPath },
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
      runWkbExport({ source: "https://example.com/post", outDir }, { kbDir, uvBinary: evilUv }),
    ).rejects.toThrow(WkbBridgeError);
  });
});
