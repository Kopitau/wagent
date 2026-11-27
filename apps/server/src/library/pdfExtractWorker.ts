import { LibraryPdfExtractionError } from "@t3tools/research-library";
import { extractPdfPagesFromFile } from "@t3tools/research-library/server";

/**
 * Isolated CLI subcommand worker (`__library-extract-pdf <pdfPath>`) matching `__document-text`:
 * - Prints JSON-encoded `LibraryExtractedPdf` to stdout.
 * - Exits with code 2 on non-retryable/corrupt PDF rejections; throws on OS/runtime failures.
 */
export async function runLibraryPdfExtractWorker(pdfFilePath: string): Promise<void> {
  if (!pdfFilePath || pdfFilePath.trim().length === 0) {
    process.exitCode = 2;
    return;
  }
  try {
    const extracted = await extractPdfPagesFromFile(pdfFilePath, {
      assetDirOverride: process.env.T3CODE_PDFJS_ASSETS_DIR,
      executablePath: process.execPath,
    });
    process.stdout.write(JSON.stringify(extracted));
  } catch (error) {
    if (error instanceof LibraryPdfExtractionError && !error.retryable) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/u.test(String(error.code))) {
      throw error;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
