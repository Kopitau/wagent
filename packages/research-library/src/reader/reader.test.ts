import { describe, expect, it } from "vite-plus/test";

import {
  PARAGRAPH_ROLES,
  WKB_ANNOTATION_KINDS,
  computeParagraphAnchor,
  detectContinuationCandidates,
  extractFigures,
  extractReferences,
  extractSections,
  findNextKeyParagraph,
  layoutRailCards,
  matchReferenceInLibrary,
  parseDeepReadGuideImport,
  resolveHoverLookup,
  segmentPageToParagraphs,
} from "./index.ts";

describe("packages/research-library/reader pure algorithms", () => {
  it("exposes all 7 DeepRead paragraph roles and 6 wkb annotation kinds", () => {
    expect(PARAGRAPH_ROLES).toHaveLength(7);
    expect(WKB_ANNOTATION_KINDS).toEqual(["重点", "存疑", "待办", "概念", "深挖", "问"]);
  });

  it("segments two-column geometry, detects continuations, and computes deterministic anchors", () => {
    const page1 = segmentPageToParagraphs({
      physicalPage: 1,
      pageText: "",
      spans: [
        { text: "1. Introduction", left: 8, top: 8, width: 30, height: 2 },
        { text: "Left column starts a sentence that", left: 8, top: 14, width: 38, height: 1.5 },
        { text: "does not end at the column bottom", left: 8, top: 16, width: 38, height: 1.5 },
        {
          text: "continues smoothly into the right column.",
          left: 54,
          top: 14,
          width: 38,
          height: 1.5,
        },
        {
          text: "Fig. 1: Architecture overview of the dual-rail layout.",
          left: 54,
          top: 30,
          width: 38,
          height: 1.5,
        },
      ],
    });

    expect(page1.some((p) => p.isHeading)).toBe(true);
    expect(page1.some((p) => p.columnSide === "left")).toBe(true);
    expect(page1.some((p) => p.columnSide === "right")).toBe(true);

    const figures = extractFigures(page1);
    expect(figures).toHaveLength(1);
    expect(figures[0]?.label).toBe("Fig. 1");

    const continuations = detectContinuationCandidates(page1);
    expect(continuations.some((c) => c.reason === "cross_column")).toBe(true);

    const anchorA = computeParagraphAnchor(1, "  Hello   World ");
    const anchorB = computeParagraphAnchor(1, "hello world");
    expect(anchorA).toBe(anchorB);
    expect(anchorA).not.toBe(computeParagraphAnchor(2, "hello world"));
  });

  it("lays out left and right rail cards without vertical overlaps", () => {
    const placed = layoutRailCards(
      [
        { key: "p_0_0", side: "left", anchorY: 100, height: 80 },
        { key: "p_0_1", side: "left", anchorY: 120, height: 70 },
        { key: "p_0_2", side: "right", anchorY: 100, height: 90 },
      ],
      { gap: 10 },
    );

    const left = placed.filter((item) => item.side === "left");
    expect(left).toHaveLength(2);
    expect(left[0]!.top).toBe(100);
    expect(left[1]!.top).toBe(190); // 100 + 80 + 10 (strictly non-overlapping)

    const right = placed.filter((item) => item.side === "right");
    expect(right[0]!.top).toBe(100); // right rail independent of left rail
  });

  it("extracts sections, references, and enforces strict DOI/title library lookup rules", () => {
    const paragraphs = segmentPageToParagraphs({
      physicalPage: 1,
      pageText: [
        "1. Introduction",
        "As shown in Fig. 2 and [1], attention mechanisms scale cleanly.",
        "Fig. 2: Scaling law across parameter budgets.",
        "2. Method",
        "We optimize the objective with bounded memory.",
      ].join("\n\n"),
    });

    const sections = extractSections(paragraphs);
    expect(sections.map((s) => s.title)).toEqual(["1. Introduction", "2. Method"]);

    const figures = extractFigures(paragraphs);
    const references = extractReferences([
      {
        physicalPage: 5,
        text: [
          "References",
          '[1] Vaswani et al. "Attention Is All You Need". NeurIPS 2017. 10.48550/arXiv.1706.03762',
        ].join("\n"),
      },
    ]);
    expect(references).toHaveLength(1);
    expect(references[0]?.doi).toBe("10.48550/arxiv.1706.03762");

    // Strict DOI conflict refusal: same title but conflicting DOI must NOT match!
    expect(
      matchReferenceInLibrary(
        { doi: "10.48550/arxiv.1706.03762", title: "Attention Is All You Need" },
        [{ id: "bad", title: "Attention Is All You Need", doi: "10.1111/other" }],
      ),
    ).toBeNull();

    // Ambiguous duplicate title without DOI must NOT guess one
    expect(
      matchReferenceInLibrary({ doi: null, title: "Attention Is All You Need" }, [
        { id: "dup-1", title: "Attention Is All You Need", doi: null },
        { id: "dup-2", title: "Attention Is All You Need", doi: null },
      ]),
    ).toBeNull();

    // Exact DOI match succeeds
    const lookup = resolveHoverLookup({
      text: "As shown in [1], attention scales.",
      cursorOffset: 13,
      figures,
      references,
      libraryCandidates: [
        {
          id: "good",
          title: "Different Local Title",
          doi: "https://doi.org/10.48550/arXiv.1706.03762",
        },
      ],
    });
    expect(lookup?.kind).toBe("citation");
    expect(lookup?.libraryMatch?.id).toBe("good");

    const figLookup = resolveHoverLookup({
      text: "See Fig. 2 for details.",
      cursorOffset: 6,
      figures,
      references,
    });
    expect(figLookup?.kind).toBe("figure");
    expect(figLookup?.physicalPage).toBe(1);

    const nextKey = findNextKeyParagraph({
      paragraphs,
      currentKey: null,
      direction: "next",
      depthMode: "highlights",
      keyPredicate: (p) => p.text.includes("bounded memory"),
    });
    expect(nextKey?.text).toContain("bounded memory");
  });

  it("imports DeepRead v1.4.0 Guide JSON and Markdown cleanly", () => {
    const jsonGuide = parseDeepReadGuideImport(
      JSON.stringify({
        type: "algorithmic",
        position: { claim: "Closed-loop action chunking stabilizes visuomotor control." },
        skeleton: { moves: [{ role: "contribution", text: "Action chunking", keys: ["p_0_2"] }] },
        method: {},
        evidence: {},
        takeaway: { summary: "Predict chunks instead of single steps." },
      }),
    );
    expect(jsonGuide.type).toBe("algorithmic");
    expect(jsonGuide.position.claim).toContain("Closed-loop");
    expect(jsonGuide.meta?.kind).toBe("import");

    const mdGuide = parseDeepReadGuideImport(
      "# Paper X-Ray\n\n- Key contribution in [p. 2 ¶3]\n- Ablation verified in [p. 4 ¶1]",
    );
    expect(mdGuide.position.claim).toBe("Paper X-Ray");
    expect(mdGuide.skeleton.moves?.[0]?.keys).toEqual(["p_1_2"]);
  });
});
