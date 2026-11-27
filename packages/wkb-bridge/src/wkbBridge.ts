// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Pure non-Effect subprocess bridge manages child processes and timeouts directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { WkbBridgeError } from "./errors.ts";
import type {
  DetectWkbOptions,
  RunWkbExportInput,
  RunWkbExportOptions,
  WkbExportResult,
  WkbInferredKind,
  WkbInstallationStatus,
} from "./types.ts";

export const WKB_DEFAULT_EXPORT_TIMEOUT_MS = 180_000;
export const WKB_DEFAULT_MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const WKB_MAX_STDOUT_BYTES = 512 * 1024;
const WKB_MAX_STDERR_BYTES = 256 * 1024;

function isWkbDirectory(dirPath: string): boolean {
  try {
    const pyprojectPath = NodePath.join(dirPath, "pyproject.toml");
    const cliPath = NodePath.join(dirPath, "src", "wkb", "cli.py");
    if (!NodeFS.existsSync(pyprojectPath) || !NodeFS.existsSync(cliPath)) {
      return false;
    }
    const content = NodeFS.readFileSync(pyprojectPath, "utf8");
    return content.includes('name = "wkb"') || content.includes("wkb.cli:main");
  } catch {
    return false;
  }
}

function findExecutableOnPath(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (NodePath.isAbsolute(binaryName)) {
    return NodeFS.existsSync(binaryName) ? binaryName : null;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extraDirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [...pathValue.split(NodePath.delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, binaryName);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH candidates.
    }
  }
  return null;
}

function normalizeOptionalUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function detectWkbInstallation(options: DetectWkbOptions = {}): WkbInstallationStatus {
  const env = options.env ?? {};
  const remoteUrl = normalizeOptionalUrl(
    options.remoteUrl ?? env.T3CODE_WKB_REMOTE_URL ?? env.WKB_REMOTE_URL,
  );
  const uvBinary = options.uvBinary ?? env.T3CODE_WKB_UV_BIN ?? "uv";
  const uvPath = findExecutableOnPath(uvBinary, env);

  const candidates: string[] = [];
  if (options.kbDir?.trim()) candidates.push(NodePath.resolve(options.kbDir.trim()));
  if (env.T3CODE_WKB_DIR?.trim()) candidates.push(NodePath.resolve(env.T3CODE_WKB_DIR.trim()));
  if (options.extraCandidateDirs) {
    for (const dir of options.extraCandidateDirs) {
      if (dir.trim()) candidates.push(NodePath.resolve(dir.trim()));
    }
  }
  if (options.homeDir) {
    candidates.push(NodePath.join(options.homeDir, "kb"));
    candidates.push(NodePath.join(options.homeDir, "Wagent", "kb"));
  }

  let kbDir: string | null = null;
  for (const candidate of candidates) {
    if (isWkbDirectory(candidate)) {
      kbDir = candidate;
      break;
    }
  }

  const localAvailable = uvPath !== null && kbDir !== null;
  const mode =
    localAvailable && remoteUrl !== null
      ? "dual"
      : localAvailable
        ? "local"
        : remoteUrl !== null
          ? "remote"
          : "unavailable";

  return {
    available: localAvailable,
    mode,
    uvPath,
    kbDir,
    remoteUrl,
  };
}

export function inferWkbEntryKind(source: string, hasPdf: boolean): WkbInferredKind {
  const trimmed = source.trim();
  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (
        host === "bilibili.com" ||
        host.endsWith(".bilibili.com") ||
        host === "b23.tv" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtu.be"
      ) {
        return "video";
      }
      if (host === "mp.weixin.qq.com") {
        return "wechat";
      }
      if (pathname.endsWith(".pdf")) {
        return "pdf";
      }
      if (pathname.endsWith(".epub")) {
        return "epub";
      }
      return "web";
    } catch {
      return "web";
    }
  }
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(".epub")) return "epub";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|mkv|mov|webm|mp3|m4a|wav|flac)$/iu.test(lower)) return "video";
  return hasPdf ? "pdf" : "file";
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = NodePath.resolve(candidatePath);
  const resolvedRoot = NodePath.resolve(rootPath);
  if (resolvedCandidate === resolvedRoot) return true;
  const relative = NodePath.relative(resolvedRoot, resolvedCandidate);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

async function validateWkbSource(
  rawSource: string,
  allowedLocalRoots: ReadonlyArray<string>,
): Promise<{ readonly normalizedSource: string; readonly sourceUrl: string | null }> {
  const source = rawSource.trim();
  if (source.length === 0 || source.length > 2048) {
    throw new WkbBridgeError("invalid_source", "wkb export source must be 1 to 2048 characters.");
  }
  if (source.includes("\u0000") || /[\r\n]/u.test(source)) {
    throw new WkbBridgeError(
      "invalid_source",
      "wkb export source contains invalid control characters.",
    );
  }
  if (source.startsWith("-")) {
    throw new WkbBridgeError("invalid_source", "wkb export source must not start with '-'.");
  }
  if (/^https?:\/\//iu.test(source)) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new WkbBridgeError("invalid_source", "wkb export URL is invalid.");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WkbBridgeError("invalid_source", "wkb export URL must not contain credentials.");
    }
    if (parsed.port !== "") {
      throw new WkbBridgeError("invalid_source", "wkb export URL must not specify a custom port.");
    }
    return { normalizedSource: parsed.toString(), sourceUrl: parsed.toString() };
  }

  if (allowedLocalRoots.length === 0) {
    throw new WkbBridgeError(
      "invalid_source",
      "Only http/https URLs are accepted unless local source roots are explicitly configured.",
    );
  }
  const realSource = await NodeFSP.realpath(source).catch(() => {
    throw new WkbBridgeError("invalid_source", "Local source path does not exist.");
  });
  const allowedRealRoots: string[] = [];
  for (const root of allowedLocalRoots) {
    const resolved = await NodeFSP.realpath(root).catch(() => null);
    if (resolved) allowedRealRoots.push(resolved);
  }
  if (!allowedRealRoots.some((root) => isPathInsideRoot(realSource, root))) {
    throw new WkbBridgeError("invalid_source", "Local source path is outside allowed roots.");
  }
  return { normalizedSource: realSource, sourceUrl: null };
}

interface RawWkbExportJson {
  readonly title?: unknown;
  readonly md?: unknown;
  readonly pdf?: unknown;
  readonly warnings?: unknown;
}

function parseWkbJsonLine(stdout: string): RawWkbExportJson {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i]!;
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed as RawWkbExportJson;
      }
    } catch {
      // Keep searching backwards in case a warning line preceded JSON.
    }
  }
  throw new WkbBridgeError("invalid_output", "wkb export did not produce valid JSON output.");
}

export async function runWkbExport(
  input: RunWkbExportInput,
  options: RunWkbExportOptions,
): Promise<WkbExportResult> {
  if (!isWkbDirectory(options.kbDir)) {
    throw new WkbBridgeError("unavailable", `wkb directory is unavailable: ${options.kbDir}`);
  }
  const env = options.env ?? {};
  const uvPath = findExecutableOnPath(options.uvBinary ?? "uv", env);
  if (!uvPath) {
    throw new WkbBridgeError("unavailable", "uv binary was not found on PATH.");
  }

  const { normalizedSource, sourceUrl } = await validateWkbSource(
    input.source,
    options.allowedLocalRoots ?? [],
  );

  await NodeFSP.mkdir(input.outDir, { recursive: true, mode: 0o700 });
  const realOutDir = await NodeFSP.realpath(input.outDir);

  const args = [
    "--directory",
    options.kbDir,
    "run",
    "wkb",
    "export",
    "--out",
    realOutDir,
    "--json",
    ...(input.pdf ? ["--pdf"] : []),
    "--",
    normalizedSource,
  ];

  const timeoutMs = options.timeoutMs ?? WKB_DEFAULT_EXPORT_TIMEOUT_MS;
  const maxMarkdownBytes = options.maxMarkdownBytes ?? WKB_DEFAULT_MAX_MARKDOWN_BYTES;

  const { stdout } = await new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new WkbBridgeError("aborted", "wkb export was cancelled before starting."));
        return;
      }
      const child = NodeChildProcess.spawn(uvPath, args, {
        cwd: options.kbDir,
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const killChild = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill errors on exited child.
        }
      };

      const onAbort = () => {
        killChild();
        finish(() => reject(new WkbBridgeError("aborted", "wkb export was cancelled.")));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        killChild();
        finish(() =>
          reject(new WkbBridgeError("timeout", `wkb export timed out after ${timeoutMs}ms.`)),
        );
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= WKB_MAX_STDOUT_BYTES) {
          stdoutChunks.push(chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= WKB_MAX_STDERR_BYTES) {
          stderrChunks.push(chunk);
        }
      });

      child.on("error", (cause) => {
        finish(() =>
          reject(
            new WkbBridgeError("process_failed", "Failed to launch uv for wkb export.", { cause }),
          ),
        );
      });

      child.on("close", (code) => {
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code !== 0) {
          finish(() =>
            reject(
              new WkbBridgeError(
                "process_failed",
                stderrText.slice(-400) || `wkb export exited with code ${code ?? -1}.`,
              ),
            ),
          );
          return;
        }
        finish(() => resolve({ stdout: stdoutText, stderr: stderrText }));
      });
    },
  );

  const parsed = parseWkbJsonLine(stdout);
  if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
    throw new WkbBridgeError("invalid_output", "wkb export JSON is missing a valid title.");
  }
  if (typeof parsed.md !== "string" || parsed.md.trim().length === 0) {
    throw new WkbBridgeError("invalid_output", "wkb export JSON is missing a valid markdown path.");
  }

  const realMdPath = await NodeFSP.realpath(parsed.md).catch(() => {
    throw new WkbBridgeError("invalid_output", "wkb export markdown file does not exist.");
  });
  if (!isPathInsideRoot(realMdPath, realOutDir)) {
    throw new WkbBridgeError(
      "invalid_output",
      "wkb export markdown path escaped output directory.",
    );
  }
  const mdStat = await NodeFSP.stat(realMdPath);
  if (mdStat.size > maxMarkdownBytes) {
    throw new WkbBridgeError(
      "invalid_output",
      `wkb export markdown exceeded ${maxMarkdownBytes} bytes.`,
    );
  }
  const markdown = await NodeFSP.readFile(realMdPath, "utf8");

  let pdfPath: string | null = null;
  if (typeof parsed.pdf === "string" && parsed.pdf.trim().length > 0) {
    const realPdfPath = await NodeFSP.realpath(parsed.pdf).catch(() => {
      throw new WkbBridgeError("invalid_output", "wkb export PDF file does not exist.");
    });
    if (!isPathInsideRoot(realPdfPath, realOutDir)) {
      throw new WkbBridgeError("invalid_output", "wkb export PDF path escaped output directory.");
    }
    pdfPath = realPdfPath;
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((value): value is string => typeof value === "string")
    : [];

  return {
    title: parsed.title.trim(),
    markdownPath: realMdPath,
    markdown,
    pdfPath,
    warnings,
    inferredKind: inferWkbEntryKind(normalizedSource, pdfPath !== null),
    sourceUrl,
  };
}
