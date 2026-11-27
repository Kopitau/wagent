export type WkbMode = "local" | "remote" | "dual" | "unavailable";

export type WkbInferredKind = "web" | "wechat" | "pdf" | "video" | "epub" | "file";

export interface WkbInstallationStatus {
  readonly available: boolean;
  readonly mode: WkbMode;
  readonly uvPath: string | null;
  readonly kbDir: string | null;
  readonly remoteUrl: string | null;
}

export interface DetectWkbOptions {
  readonly kbDir?: string | undefined;
  readonly remoteUrl?: string | undefined;
  readonly uvBinary?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly homeDir?: string | undefined;
  readonly extraCandidateDirs?: ReadonlyArray<string> | undefined;
}

export interface RunWkbExportInput {
  readonly source: string;
  readonly outDir: string;
  readonly pdf?: boolean | undefined;
}

export interface RunWkbExportOptions {
  readonly kbDir: string;
  readonly uvBinary?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly allowedLocalRoots?: ReadonlyArray<string> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly maxMarkdownBytes?: number | undefined;
}

export interface WkbExportResult {
  readonly title: string;
  readonly markdownPath: string;
  readonly markdown: string;
  readonly pdfPath: string | null;
  readonly warnings: ReadonlyArray<string>;
  readonly inferredKind: WkbInferredKind;
  readonly sourceUrl: string | null;
}
