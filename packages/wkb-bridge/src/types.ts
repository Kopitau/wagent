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

export type WkbAnnotationKind = "重点" | "存疑" | "待办" | "概念" | "深挖" | "问";

export interface WkbAnnotationItem {
  readonly id: string;
  readonly kind: WkbAnnotationKind;
  readonly color?: string | undefined;
  readonly text: string;
  readonly note?: string | undefined;
  readonly location: {
    readonly page?: number | undefined;
    readonly chapter?: number | undefined;
    readonly offset?: number | undefined;
  };
  readonly created?: string | undefined;
  readonly updated?: string | undefined;
  readonly deleted?: boolean | undefined;
}

export interface RunWkbAnnotateInput {
  readonly sourceId: string;
  readonly annotations: ReadonlyArray<WkbAnnotationItem>;
}

export interface RunWkbAnnotateOptions {
  readonly kbDir?: string | null | undefined;
  readonly remoteUrl?: string | null | undefined;
  readonly remoteToken?: string | null | undefined;
  readonly uvBinary?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface WkbAnnotateResult {
  readonly mode: "remote" | "local";
  readonly summary: string;
  readonly syncedCount: number;
}

export interface RunWkbSubmitInput {
  readonly title: string;
  readonly url?: string | null | undefined;
  readonly text: string;
  readonly note?: string | undefined;
}

export interface WkbSubmitResult {
  readonly mode: "remote" | "local";
  readonly summary: string;
}
