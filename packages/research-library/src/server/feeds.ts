import * as NodeCrypto from "node:crypto";

import {
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_TITLE_CHARS,
  type LibraryFeedKind,
  type ParsedFeedItem,
} from "../types.ts";
import { normalizeLibraryUrl } from "../validation.ts";
import { fetchPublicTextDocument, type FetchWebArticleOptions } from "./webFetch.ts";

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&#(\d+);/gu, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    });
}

function stripMarkup(raw: string): string {
  return decodeXmlEntities(raw)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function readTagText(block: string, tagNames: ReadonlyArray<string>): string | null {
  for (const tag of tagNames) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "iu").exec(block);
    if (match?.[1] !== undefined) {
      const cleaned = stripMarkup(match[1]);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

function readAllTagText(block: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "giu");
  const out: string[] = [];
  for (const match of block.matchAll(pattern)) {
    const cleaned = stripMarkup(match[1] ?? "");
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

function extractAtomLink(block: string): string | null {
  const linkTags = [...block.matchAll(/<link\b([^>]*)\/?>/giu)];
  let fallback: string | null = null;
  for (const match of linkTags) {
    const attrs = match[1] ?? "";
    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(attrs);
    if (!hrefMatch?.[1]) continue;
    const href = decodeXmlEntities(hrefMatch[1]).trim();
    const relMatch = /\brel\s*=\s*["']([^"']+)["']/iu.exec(attrs);
    const rel = relMatch?.[1]?.toLowerCase() ?? "alternate";
    if (rel === "alternate") {
      return href;
    }
    if (fallback === null) {
      fallback = href;
    }
  }
  return fallback;
}

function extractAtomCategories(block: string): string[] {
  const out = new Set<string>();
  for (const match of block.matchAll(/<category\b([^>]*)\/?>/giu)) {
    const attrs = match[1] ?? "";
    const termMatch = /\bterm\s*=\s*["']([^"']+)["']/iu.exec(attrs);
    const term = termMatch?.[1] ? decodeXmlEntities(termMatch[1]).trim() : "";
    if (term.length > 0) out.add(term);
  }
  return [...out];
}

function canonicalizeFeedItemUrl(
  rawUrl: string | null,
  kind: LibraryFeedKind,
  baseUrl?: string,
): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const resolved =
      /^https?:\/\//iu.test(trimmed) || !baseUrl ? trimmed : new URL(trimmed, baseUrl).toString();
    const upgraded =
      kind === "arxiv" && resolved.startsWith("http://arxiv.org/")
        ? `https://${resolved.slice("http://".length)}`
        : resolved;
    return normalizeLibraryUrl(upgraded);
  } catch {
    return null;
  }
}

function buildDeterministicExternalId(
  rawId: string | null,
  normalizedUrl: string | null,
  title: string,
): string {
  const candidate = rawId?.trim() || normalizedUrl;
  if (candidate && candidate.length > 0) {
    return candidate.slice(0, 512);
  }
  return `sha256:${NodeCrypto.createHash("sha256").update(title).digest("hex").slice(0, 32)}`;
}

/**
 * Parses RSS 2.0 (`<item>`) and Atom / arXiv API (`<entry>`) XML feeds into normalized items.
 */
export function parseFeedXml(
  xml: string,
  fallbackKind: LibraryFeedKind,
  baseUrl?: string,
): ReadonlyArray<ParsedFeedItem> {
  const items: ParsedFeedItem[] = [];
  const seenExternalIds = new Set<string>();

  const atomBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/giu)];
  if (atomBlocks.length > 0) {
    for (const match of atomBlocks) {
      const block = match[1] ?? "";
      const title = (readTagText(block, ["title"]) ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, LIBRARY_MAX_TITLE_CHARS);
      if (title.length === 0) continue;

      const rawId = readTagText(block, ["id"]);
      const rawLink = extractAtomLink(block) ?? rawId;
      const url = canonicalizeFeedItemUrl(rawLink, fallbackKind, baseUrl);
      const externalId = buildDeterministicExternalId(rawId, url, title);
      if (seenExternalIds.has(externalId)) continue;
      seenExternalIds.add(externalId);

      const summary = (readTagText(block, ["summary", "content"]) ?? "").slice(
        0,
        LIBRARY_MAX_BODY_CHARS,
      );
      const authors = readAllTagText(block, "name");
      const categories = extractAtomCategories(block);
      const publishedAt = readTagText(block, ["published", "updated"]);

      items.push({
        externalId,
        title,
        url,
        summary,
        authors,
        categories,
        publishedAt,
      });
    }
    return items;
  }

  const rssBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)];
  for (const match of rssBlocks) {
    const block = match[1] ?? "";
    const title = (readTagText(block, ["title"]) ?? "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, LIBRARY_MAX_TITLE_CHARS);
    if (title.length === 0) continue;

    const rawGuid = readTagText(block, ["guid"]);
    const rawLink = readTagText(block, ["link"]);
    const url = canonicalizeFeedItemUrl(rawLink, fallbackKind, baseUrl);
    const externalId = buildDeterministicExternalId(rawGuid, url, title);
    if (seenExternalIds.has(externalId)) continue;
    seenExternalIds.add(externalId);

    const summary = (readTagText(block, ["content:encoded", "description", "summary"]) ?? "").slice(
      0,
      LIBRARY_MAX_BODY_CHARS,
    );
    const authors = [
      ...readAllTagText(block, "dc:creator"),
      ...readAllTagText(block, "author"),
    ].filter((value, idx, arr) => arr.indexOf(value) === idx);
    const categories = readAllTagText(block, "category");
    const publishedAt = readTagText(block, ["pubDate", "dc:date"]);

    items.push({
      externalId,
      title,
      url,
      summary,
      authors,
      categories,
      publishedAt,
    });
  }

  return items;
}

export async function fetchFeedItems(
  feedUrl: string,
  kind: LibraryFeedKind,
  options: FetchWebArticleOptions = {},
): Promise<ReadonlyArray<ParsedFeedItem>> {
  const doc = await fetchPublicTextDocument(feedUrl, options);
  return parseFeedXml(doc.text, kind, doc.finalUrl);
}
