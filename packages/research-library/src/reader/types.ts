export const READING_ANCHOR_ALGO_VERSION = 1;

export const PARAGRAPH_ROLES = [
  "background",
  "gap",
  "prior",
  "contribution",
  "method",
  "result",
  "limitation",
] as const;
export type ParagraphRole = (typeof PARAGRAPH_ROLES)[number];

export const READING_DEPTH_MODES = ["full", "highlights", "margins"] as const;
export type ReadingDepthMode = (typeof READING_DEPTH_MODES)[number];

export const RAIL_LAYOUT_MODES = ["split", "right"] as const;
export type RailLayoutMode = (typeof RAIL_LAYOUT_MODES)[number];

export const WKB_ANNOTATION_KINDS = ["重点", "存疑", "待办", "概念", "深挖", "问"] as const;
export type WkbAnnotationKind = (typeof WKB_ANNOTATION_KINDS)[number];

export const HIGHLIGHT_DENSITIES = ["off", "low", "medium", "high"] as const;
export type HighlightDensity = (typeof HIGHLIGHT_DENSITIES)[number];

export interface ParagraphRoleStyle {
  readonly role: ParagraphRole;
  readonly accent: string;
  readonly fill: string;
  readonly labelZh: string;
  readonly labelEn: string;
}

export const PARAGRAPH_ROLE_STYLES: Readonly<Record<ParagraphRole, ParagraphRoleStyle>> = {
  background: {
    role: "background",
    accent: "#475569",
    fill: "#e2e8f0",
    labelZh: "背景",
    labelEn: "Background",
  },
  gap: {
    role: "gap",
    accent: "#c2410c",
    fill: "#ffedd5",
    labelZh: "空白",
    labelEn: "Gap",
  },
  prior: {
    role: "prior",
    accent: "#a16207",
    fill: "#fef3c7",
    labelZh: "已有工作",
    labelEn: "Prior work",
  },
  contribution: {
    role: "contribution",
    accent: "#7c3aed",
    fill: "#ede9fe",
    labelZh: "贡献",
    labelEn: "Contribution",
  },
  method: {
    role: "method",
    accent: "#1d4ed8",
    fill: "#dbeafe",
    labelZh: "方法",
    labelEn: "Method",
  },
  result: {
    role: "result",
    accent: "#047857",
    fill: "#d1fae5",
    labelZh: "结果",
    labelEn: "Result",
  },
  limitation: {
    role: "limitation",
    accent: "#be123c",
    fill: "#ffe4e6",
    labelZh: "局限",
    labelEn: "Limitation",
  },
};

/** Normalized page rectangle in percentage coordinates (0..100). */
export interface PageRectPct {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TextSpanBox {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize?: number | undefined;
}

export interface PaperParagraphBlock {
  readonly key: string;
  readonly label: string;
  readonly physicalPage: number;
  readonly paragraphIndex: number;
  readonly anchor: string;
  readonly text: string;
  readonly rect: PageRectPct;
  readonly columnSide: "left" | "right" | "full";
  readonly isHeading: boolean;
  readonly isCaption: boolean;
  readonly figureLabel: string | null;
  readonly figureKind: "figure" | "table" | null;
}

export interface ContinuationCandidate {
  readonly leadKey: string;
  readonly tailKey: string;
  readonly reason: "cross_column" | "cross_page" | "unfinished_sentence";
}

export interface RailCardInput {
  readonly key: string;
  readonly side: "left" | "right";
  readonly anchorY: number;
  readonly height: number;
}

export interface RailCardPlacement {
  readonly key: string;
  readonly side: "left" | "right";
  readonly anchorY: number;
  readonly top: number;
  readonly height: number;
  readonly connectorFromY: number;
  readonly connectorToY: number;
}

export interface ReadingSection {
  readonly id: string;
  readonly title: string;
  readonly startPage: number;
  readonly endPage: number;
  readonly firstParagraphKey: string;
  readonly wordCount: number;
  readonly estimatedMinutes: number;
}

export interface PaperFigureItem {
  readonly id: string;
  readonly kind: "figure" | "table";
  readonly number: string;
  readonly label: string;
  readonly caption: string;
  readonly physicalPage: number;
  readonly paragraphKey: string;
  readonly rect: PageRectPct;
}

export interface ReferenceEntry {
  readonly index: number | null;
  readonly key: string;
  readonly rawText: string;
  readonly authors: string;
  readonly year: string | null;
  readonly title: string | null;
  readonly doi: string | null;
  readonly physicalPage: number;
}

export interface LibraryLookupCandidate {
  readonly id: string;
  readonly title: string;
  readonly doi?: string | null | undefined;
}

export interface HoverLookupResult {
  readonly kind: "citation" | "figure" | "table";
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly physicalPage: number | null;
  readonly paragraphKey: string | null;
  readonly reference?: ReferenceEntry | undefined;
  readonly figure?: PaperFigureItem | undefined;
  readonly libraryMatch: LibraryLookupCandidate | null;
}

export interface DeepReadGuidePathItem {
  readonly step: string;
  readonly text: string;
  readonly basis?: "source" | "inference" | "pending" | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideOrderItem {
  readonly text: string;
  readonly minutes?: number | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideMove {
  readonly role?: string | undefined;
  readonly text: string;
  readonly keys?: ReadonlyArray<string> | undefined;
  readonly status?: "proven" | "partial" | "unproven" | "pending" | undefined;
}

export interface DeepReadGuideTerm {
  readonly term: string;
  readonly translation?: string | undefined;
  readonly variants?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideComponent {
  readonly name: string;
  readonly verdict?:
    | "load-bearing"
    | "contributing"
    | "decorative"
    | "unestablished"
    | "pending"
    | undefined;
  readonly basis?: string | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideFormula {
  readonly latex: string;
  readonly purpose?: string | undefined;
  readonly symbols?:
    | ReadonlyArray<{
        readonly symbol: string;
        readonly shape?: string | undefined;
        readonly meaning: string;
      }>
    | undefined;
  readonly example?: string | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideEvidenceItem {
  readonly claim: string;
  readonly evidence: string;
  readonly supports?: string | undefined;
  readonly notSupports?: string | undefined;
  readonly status?: "proven" | "partial" | "unproven" | "pending" | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideCheck {
  readonly text: string;
  readonly effect?: "changes" | "weakens" | "scopes" | "wording" | undefined;
  readonly state?: "open" | "ok" | "problem" | undefined;
}

export interface DeepReadGuideHedge {
  readonly quote: string;
  readonly strength?: "strong" | "hedged" | "speculative" | "outlook" | undefined;
  readonly note?: string | undefined;
  readonly keys?: ReadonlyArray<string> | undefined;
}

export interface DeepReadGuideIdea {
  readonly title: string;
  readonly basis?: string | undefined;
  readonly hypothesis?: string | undefined;
  readonly test?: string | undefined;
  readonly risk?: string | undefined;
}

/** Exact DeepRead v1.4.0 5-stage Guide contract (`docs/GUIDE_SCHEMA.md`). */
export interface DeepReadGuide {
  readonly type?: string | undefined;
  readonly position: {
    readonly claim?: string | undefined;
    readonly path?: ReadonlyArray<DeepReadGuidePathItem> | undefined;
    readonly focus?: ReadonlyArray<string> | undefined;
    readonly order?: ReadonlyArray<DeepReadGuideOrderItem> | undefined;
    readonly questions?: ReadonlyArray<string> | undefined;
  };
  readonly skeleton: {
    readonly moves?: ReadonlyArray<DeepReadGuideMove> | undefined;
    readonly terms?: ReadonlyArray<DeepReadGuideTerm> | undefined;
  };
  readonly method: {
    readonly components?: ReadonlyArray<DeepReadGuideComponent> | undefined;
    readonly insight?:
      | {
          readonly surface?: string | undefined;
          readonly core?: string | undefined;
          readonly transferable?: string | undefined;
        }
      | undefined;
    readonly formulas?: ReadonlyArray<DeepReadGuideFormula> | undefined;
  };
  readonly evidence: {
    readonly chain?: ReadonlyArray<DeepReadGuideEvidenceItem> | undefined;
    readonly checks?: ReadonlyArray<DeepReadGuideCheck> | undefined;
    readonly hedges?: ReadonlyArray<DeepReadGuideHedge> | undefined;
  };
  readonly takeaway: {
    readonly summary?: string | undefined;
    readonly learned?: ReadonlyArray<string> | undefined;
    readonly ideas?: ReadonlyArray<DeepReadGuideIdea> | undefined;
  };
  readonly markdown?: {
    readonly xray?: string | undefined;
    readonly card?: string | undefined;
  };
  readonly meta?: {
    readonly kind?: string | undefined;
    readonly model?: string | undefined;
    readonly source?: string | undefined;
  };
}
