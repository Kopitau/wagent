// @effect-diagnostics nodeBuiltinImport:off -- Pure non-Effect PDF worker resolves pdfjs-dist assets and reads files from disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { LibraryPdfExtractionError } from "../errors.ts";
import {
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_TITLE_CHARS,
  LIBRARY_PDF_MAX_EXTRACT_CHARS,
  type LibraryEntryPage,
  type LibraryExtractedPdf,
} from "../types.ts";

interface PdfjsTextItem {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

interface PdfjsPageProxy {
  readonly getTextContent: () => Promise<{ readonly items: ReadonlyArray<PdfjsTextItem> }>;
  readonly cleanup: () => void;
}

interface PdfjsDocumentProxy {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfjsPageProxy>;
  readonly getMetadata: () => Promise<{ readonly info?: { readonly Title?: unknown } | undefined }>;
  readonly cleanup?: () => void;
}

interface PdfjsLoadingTask {
  readonly promise: Promise<PdfjsDocumentProxy>;
  readonly destroy: () => Promise<void>;
}

interface PdfjsLegacyModule {
  readonly GlobalWorkerOptions: { workerSrc: string };
  readonly getDocument: (params: Record<string, unknown>) => PdfjsLoadingTask;
}

export interface PdfjsAssetLocations {
  readonly pdfModuleUrl: string;
  readonly workerModuleUrl: string;
  readonly cMapUrl: string;
  readonly standardFontDataUrl: string;
}

function ensureTrailingSep(dirPath: string): string {
  return dirPath.endsWith(NodePath.sep) ? dirPath : `${dirPath}${NodePath.sep}`;
}

export function resolvePdfjsAssetLocations(options?: {
  readonly assetDirOverride?: string | undefined;
  readonly executablePath?: string | undefined;
}): PdfjsAssetLocations {
  const candidates: string[] = [];

  if (options?.assetDirOverride?.trim()) {
    candidates.push(NodePath.resolve(options.assetDirOverride.trim()));
  }

  const resolvers: Array<() => string | null> = [
    () => {
      try {
        const req = NodeModule.createRequire(import.meta.url);
        return NodePath.dirname(req.resolve("pdfjs-dist/package.json"));
      } catch {
        return null;
      }
    },
    () => {
      if (!options?.executablePath) return null;
      try {
        const req = NodeModule.createRequire(options.executablePath);
        return NodePath.dirname(req.resolve("pdfjs-dist/package.json"));
      } catch {
        return null;
      }
    },
  ];

  for (const resolve of resolvers) {
    const found = resolve();
    if (found) candidates.push(found);
  }

  if (options?.executablePath) {
    const execDir = NodePath.dirname(options.executablePath);
    candidates.push(NodePath.join(execDir, "node_modules", "pdfjs-dist"));
    candidates.push(NodePath.join(execDir, "pdfjs-dist"));
  }

  for (const root of candidates) {
    const pdfMjs = NodePath.join(root, "legacy", "build", "pdf.mjs");
    const workerMjs = NodePath.join(root, "legacy", "build", "pdf.worker.mjs");
    const cmapsDir = NodePath.join(root, "cmaps");
    const fontsDir = NodePath.join(root, "standard_fonts");
    if (
      NodeFS.existsSync(pdfMjs) &&
      NodeFS.existsSync(workerMjs) &&
      NodeFS.existsSync(cmapsDir) &&
      NodeFS.existsSync(fontsDir)
    ) {
      return {
        pdfModuleUrl: NodeURL.pathToFileURL(pdfMjs).href,
        workerModuleUrl: NodeURL.pathToFileURL(workerMjs).href,
        cMapUrl: ensureTrailingSep(cmapsDir),
        standardFontDataUrl: ensureTrailingSep(fontsDir),
      };
    }
  }

  throw new LibraryPdfExtractionError(
    "pdfjs-dist runtime modules and font/CMap assets could not be located.",
    { retryable: true },
  );
}

function normalizePageText(items: ReadonlyArray<PdfjsTextItem>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const cleaned = item.str.replace(/\u0000/gu, "");
    if (cleaned.length > 0) {
      parts.push(cleaned);
    }
    if (item.hasEOL === true) {
      parts.push("\n");
    } else if (cleaned.length > 0 && !cleaned.endsWith(" ")) {
      parts.push(" ");
    }
  }
  return parts
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export interface ExtractPdfPagesOptions {
  readonly maxTotalChars?: number | undefined;
  readonly maxBodyChars?: number | undefined;
  readonly assetDirOverride?: string | undefined;
  readonly executablePath?: string | undefined;
}

/**
 * Extracts 1-based physical page texts from a PDF file using `pdfjs-dist` legacy Node build
 * with explicit `cmaps/` and `standard_fonts/` asset directories.
 * Always preserves the true `pageCount` (`doc.numPages`), distinguishing `ok`, `empty_scan`,
 * `truncated`, and `skipped` pages.
 */
export async function extractPdfPagesFromFile(
  pdfFilePath: string,
  options: ExtractPdfPagesOptions = {},
): Promise<LibraryExtractedPdf> {
  const maxTotalChars = options.maxTotalChars ?? LIBRARY_PDF_MAX_EXTRACT_CHARS;
  const maxBodyChars = options.maxBodyChars ?? LIBRARY_MAX_BODY_CHARS;

  const bytes = await NodeFSP.readFile(pdfFilePath).catch((cause) => {
    throw new LibraryPdfExtractionError("Unable to read PDF file for text extraction.", {
      retryable: true,
      cause,
    });
  });

  if (bytes.byteLength === 0) {
    throw new LibraryPdfExtractionError("PDF file is empty.", { retryable: false });
  }

  const assets = resolvePdfjsAssetLocations({
    assetDirOverride: options.assetDirOverride,
    executablePath: options.executablePath,
  });

  const pdfjs = (await import(assets.pdfModuleUrl)) as PdfjsLegacyModule;
  pdfjs.GlobalWorkerOptions.workerSrc = assets.workerModuleUrl;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  let doc: PdfjsDocumentProxy | null = null;
  try {
    doc = await loadingTask.promise.catch((cause) => {
      throw new LibraryPdfExtractionError("Unable to parse PDF document.", {
        retryable: false,
        cause,
      });
    });

    const pageCount = Math.max(0, Math.trunc(doc.numPages));
    let title: string | null = null;
    try {
      const metadata = await doc.getMetadata();
      if (typeof metadata.info?.Title === "string") {
        const cleanedTitle = metadata.info.Title.replace(/\u0000/gu, "")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, LIBRARY_MAX_TITLE_CHARS);
        if (cleanedTitle.length > 0) {
          title = cleanedTitle;
        }
      }
    } catch {
      // Metadata parsing is optional.
    }

    const pages: LibraryEntryPage[] = [];
    const bodyParts: string[] = [];
    let bodyChars = 0;
    let totalExtractedChars = 0;

    for (let physicalPage = 1; physicalPage <= pageCount; physicalPage += 1) {
      if (totalExtractedChars >= maxTotalChars) {
        pages.push({
          physicalPage,
          text: "",
          extractionStatus: "skipped",
        });
        continue;
      }

      const page = await doc.getPage(physicalPage);
      try {
        const content = await page.getTextContent();
        const rawText = normalizePageText(content.items);
        if (rawText.length === 0) {
          pages.push({
            physicalPage,
            text: "",
            extractionStatus: "empty_scan",
          });
          continue;
        }

        const remaining = maxTotalChars - totalExtractedChars;
        const truncated = rawText.length > remaining;
        const text = truncated ? rawText.slice(0, remaining) : rawText;
        totalExtractedChars += text.length;
        pages.push({
          physicalPage,
          text,
          extractionStatus: truncated ? "truncated" : "ok",
        });

        if (bodyChars < maxBodyChars) {
          const prefix =
            bodyParts.length > 0 ? `\n\n[p.${physicalPage}]\n` : `[p.${physicalPage}]\n`;
          const remainingBody = maxBodyChars - bodyChars - prefix.length;
          if (remainingBody > 0) {
            const chunk = text.length > remainingBody ? text.slice(0, remainingBody) : text;
            bodyParts.push(`${prefix}${chunk}`);
            bodyChars += prefix.length + chunk.length;
          }
        }
      } finally {
        page.cleanup();
      }
    }

    return {
      pageCount,
      title,
      body: bodyParts.join("").slice(0, maxBodyChars),
      pages,
    };
  } finally {
    doc?.cleanup?.();
    await loadingTask.destroy().catch(() => undefined);
  }
}
