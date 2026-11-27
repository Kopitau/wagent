// @effect-diagnostics nodeBuiltinImport:off -- Pure non-Effect blob storage interacts with node:crypto, node:fs, and node:path directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { LibraryUploadTooLargeError, LibraryValidationError } from "../errors.ts";
import {
  LIBRARY_DEFAULT_BLOB_GC_GRACE_MS,
  LIBRARY_MAX_PDF_UPLOAD_BYTES,
  type LibraryBlobGcReport,
} from "../types.ts";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const PDF_HEADER_SEARCH_BYTES = 1024;
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export interface StagedPdfBlob {
  readonly tmpPath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PublishedPdfBlob {
  readonly sha256: string;
  readonly bytes: number;
  readonly path: string;
  readonly reused: boolean;
}

export function isValidBlobSha256(sha256: string): boolean {
  return SHA256_HEX_PATTERN.test(sha256);
}

export function resolveBlobPath(blobsDir: string, sha256: string): string | null {
  if (!isValidBlobSha256(sha256)) return null;
  const resolvedDir = NodePath.resolve(blobsDir);
  const candidate = NodePath.resolve(resolvedDir, `${sha256}.pdf`);
  if (NodePath.dirname(candidate) !== resolvedDir) return null;
  return candidate;
}

async function chmodPosixBestEffort(
  targetPath: string,
  mode: number,
  isWindows: boolean,
): Promise<void> {
  if (isWindows) return;
  try {
    await NodeFSP.chmod(targetPath, mode);
  } catch {
    // Non-fatal on filesystems that disallow chmod.
  }
}

async function removeForceBestEffort(targetPath: string): Promise<void> {
  try {
    await NodeFSP.rm(targetPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export function isWindowsFileLockError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}

async function hashFileSha256(
  filePath: string,
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const stream = NodeFS.createReadStream(filePath);
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buf.byteLength;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function ensureBlobsDir(blobsDir: string, isWindows: boolean): Promise<void> {
  await NodeFSP.mkdir(blobsDir, { recursive: true, mode: 0o700 });
  await chmodPosixBestEffort(blobsDir, 0o700, isWindows);
}

/**
 * Streams raw PDF bytes into `blobs/.tmp-<uuid>` while counting ACTUAL received bytes
 * (never trusting Content-Length), computing SHA-256 on the fly, and validating the `%PDF-` header.
 * Any error, abort, invalid magic header, or overflow deletes the temp file immediately.
 */
export async function stagePdfBlobFromStream(input: {
  readonly blobsDir: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly maxBytes?: number | undefined;
  readonly isWindows?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<StagedPdfBlob> {
  const maxBytes = input.maxBytes ?? LIBRARY_MAX_PDF_UPLOAD_BYTES;
  const isWindows = input.isWindows ?? false;
  await ensureBlobsDir(input.blobsDir, isWindows);

  const tmpPath = NodePath.join(input.blobsDir, `.tmp-${NodeCrypto.randomUUID()}`);
  const handle = await NodeFSP.open(tmpPath, "wx", 0o600);
  const hash = NodeCrypto.createHash("sha256");
  const headerProbe: Buffer[] = [];
  let headerProbeBytes = 0;
  let receivedBytes = 0;
  let kept = false;

  try {
    for await (const rawChunk of input.chunks) {
      if (input.signal?.aborted) {
        throw new LibraryValidationError("file", "PDF upload was cancelled.");
      }
      if (rawChunk.byteLength === 0) continue;
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        throw new LibraryUploadTooLargeError(maxBytes, receivedBytes);
      }
      if (headerProbeBytes < PDF_HEADER_SEARCH_BYTES) {
        const take = Math.min(chunk.byteLength, PDF_HEADER_SEARCH_BYTES - headerProbeBytes);
        headerProbe.push(chunk.subarray(0, take));
        headerProbeBytes += take;
      }
      hash.update(chunk);
      await handle.write(chunk);
    }

    if (input.signal?.aborted) {
      throw new LibraryValidationError("file", "PDF upload was cancelled.");
    }
    if (receivedBytes === 0) {
      throw new LibraryValidationError("file", "Uploaded PDF file is empty.");
    }
    const headerBuffer = Buffer.concat(headerProbe);
    if (!headerBuffer.includes(PDF_MAGIC)) {
      throw new LibraryValidationError("file", "Uploaded file is not a valid PDF document.");
    }

    await handle.sync().catch(() => undefined);
    await handle.close();
    await chmodPosixBestEffort(tmpPath, 0o600, isWindows);
    kept = true;
    return {
      tmpPath,
      sha256: hash.digest("hex"),
      bytes: receivedBytes,
    };
  } finally {
    if (!kept) {
      await handle.close().catch(() => undefined);
      await removeForceBestEffort(tmpPath);
    }
  }
}

export async function stagePdfBlobFromFile(input: {
  readonly blobsDir: string;
  readonly sourcePath: string;
  readonly maxBytes?: number | undefined;
  readonly isWindows?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<StagedPdfBlob> {
  const stream = NodeFS.createReadStream(input.sourcePath);
  return stagePdfBlobFromStream({
    blobsDir: input.blobsDir,
    chunks: stream as AsyncIterable<Uint8Array>,
    maxBytes: input.maxBytes,
    isWindows: input.isWindows,
    signal: input.signal,
  });
}

export async function cleanupStagedBlob(tmpPath: string): Promise<void> {
  await removeForceBestEffort(tmpPath);
}

/**
 * Publishes a staged `.tmp-*` file into immutable content-addressed `blobs/<sha256>.pdf`
 * exclusively without replacing an intact existing blob. Always removes `staged.tmpPath`.
 * Caller MUST hold the per-environment write coordinator lock (shared with GC).
 */
export async function publishStagedPdfBlob(input: {
  readonly blobsDir: string;
  readonly staged: StagedPdfBlob;
  readonly isWindows?: boolean | undefined;
}): Promise<PublishedPdfBlob> {
  const isWindows = input.isWindows ?? false;
  const finalPath = resolveBlobPath(input.blobsDir, input.staged.sha256);
  if (!finalPath) {
    await removeForceBestEffort(input.staged.tmpPath);
    throw new LibraryValidationError("blobSha256", "Invalid staged blob hash.");
  }

  try {
    let published = false;
    try {
      await NodeFSP.link(input.staged.tmpPath, finalPath);
      published = true;
    } catch (linkError) {
      if (linkError instanceof Error && "code" in linkError && linkError.code === "EEXIST") {
        published = false;
      } else {
        try {
          await NodeFSP.copyFile(input.staged.tmpPath, finalPath, NodeFSP.constants.COPYFILE_EXCL);
          published = true;
        } catch (copyError) {
          if (copyError instanceof Error && "code" in copyError && copyError.code === "EEXIST") {
            published = false;
          } else {
            throw copyError;
          }
        }
      }
    }

    if (published) {
      await chmodPosixBestEffort(finalPath, 0o600, isWindows);
      return {
        sha256: input.staged.sha256,
        bytes: input.staged.bytes,
        path: finalPath,
        reused: false,
      };
    }

    // Existing file found: verify size & SHA-256 before reusing; repair only if corrupted.
    const existingStat = await NodeFSP.stat(finalPath);
    let intact =
      existingStat.isFile() && existingStat.size === input.staged.bytes && existingStat.size > 0;
    if (intact) {
      const existingHash = await hashFileSha256(finalPath);
      intact =
        existingHash.sha256 === input.staged.sha256 && existingHash.bytes === input.staged.bytes;
    }
    if (!intact) {
      await NodeFSP.rename(input.staged.tmpPath, finalPath);
      await chmodPosixBestEffort(finalPath, 0o600, isWindows);
      return {
        sha256: input.staged.sha256,
        bytes: input.staged.bytes,
        path: finalPath,
        reused: false,
      };
    }

    return {
      sha256: input.staged.sha256,
      bytes: input.staged.bytes,
      path: finalPath,
      reused: true,
    };
  } finally {
    await removeForceBestEffort(input.staged.tmpPath);
  }
}

export function blobExistsOnDisk(blobsDir: string, sha256: string | null): boolean {
  if (sha256 === null) return false;
  const resolved = resolveBlobPath(blobsDir, sha256);
  if (!resolved) return false;
  try {
    const stat = NodeFS.statSync(resolved);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Startup recovery & delayed GC (caller MUST hold the write coordinator lock):
 * sweeps stale `.tmp-*` & expired 0-ref blobs (rechecked under lock, tolerating Windows EBUSY),
 * and reports DB-referenced blobs missing on disk.
 */
export async function recoverAndSweepBlobs(input: {
  readonly blobsDir: string;
  readonly referencedSha256s: ReadonlySet<string>;
  readonly countBlobReferences: (sha256: string) => number;
  readonly nowMs: number;
  readonly orphanGraceMs?: number | undefined;
  readonly tempGraceMs?: number | undefined;
  readonly unlinkFn?: ((filePath: string) => Promise<void>) | undefined;
}): Promise<LibraryBlobGcReport> {
  const orphanGraceMs = input.orphanGraceMs ?? LIBRARY_DEFAULT_BLOB_GC_GRACE_MS;
  const tempGraceMs = input.tempGraceMs ?? LIBRARY_DEFAULT_BLOB_GC_GRACE_MS;
  const unlinkFn = input.unlinkFn ?? ((filePath: string) => NodeFSP.unlink(filePath));

  let removedTempFiles = 0;
  let removedOrphanBlobs = 0;
  let deferredLockedBlobs = 0;
  const existingBlobSha256s = new Set<string>();

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = await NodeFSP.readdir(input.blobsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        removedTempFiles: 0,
        removedOrphanBlobs: 0,
        deferredLockedBlobs: 0,
        missingBlobSha256s: [...input.referencedSha256s].sort(),
      };
    }
    throw error;
  }

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    const filePath = NodePath.join(input.blobsDir, name);

    if (name.startsWith(".tmp-")) {
      const stat = await NodeFSP.stat(filePath).catch(() => null);
      if (!stat) continue;
      if (input.nowMs - stat.mtimeMs >= tempGraceMs) {
        try {
          await unlinkFn(filePath);
          removedTempFiles += 1;
        } catch (error) {
          if (isWindowsFileLockError(error)) {
            deferredLockedBlobs += 1;
          }
        }
      }
      continue;
    }

    if (!name.endsWith(".pdf")) continue;
    const sha256 = name.slice(0, -4);
    if (!isValidBlobSha256(sha256)) continue;

    const stat = await NodeFSP.stat(filePath).catch(() => null);
    if (!stat) continue;

    if (stat.size > 0) {
      existingBlobSha256s.add(sha256);
    }

    if (input.referencedSha256s.has(sha256)) continue;
    if (input.nowMs - stat.mtimeMs < orphanGraceMs) continue;

    // Double-check DB reference count inside the coordinator lock right before unlinking.
    if (input.countBlobReferences(sha256) > 0) continue;

    try {
      await unlinkFn(filePath);
      removedOrphanBlobs += 1;
      existingBlobSha256s.delete(sha256);
    } catch (error) {
      if (isWindowsFileLockError(error)) {
        deferredLockedBlobs += 1;
      } else if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  const missingBlobSha256s: string[] = [];
  for (const sha256 of input.referencedSha256s) {
    if (!existingBlobSha256s.has(sha256)) {
      missingBlobSha256s.push(sha256);
    }
  }
  missingBlobSha256s.sort();

  return {
    removedTempFiles,
    removedOrphanBlobs,
    deferredLockedBlobs,
    missingBlobSha256s,
  };
}
