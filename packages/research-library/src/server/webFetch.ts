// @effect-diagnostics nodeBuiltinImport:off -- Pure non-Effect SSRF-protected fetcher requires node:dns, node:http, node:https, and node:net for DNS-pinned sockets.
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";

import { LibrarySsrfRejectedError, LibraryValidationError } from "../errors.ts";
import {
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_TITLE_CHARS,
  type LibraryEntryKind,
} from "../types.ts";
import { normalizeLibraryUrl } from "../validation.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// IANA special-purpose IPv4 & IPv6 non-globally-routable ranges.
// Intentionally does NOT inherit any webhook test allowlist.
const notGlobalV4 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  notGlobalV4.addSubnet(network, prefix, "ipv4");
}

const globalUnicastV6 = new NodeNet.BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");

const notGlobalV6 = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  notGlobalV6.addSubnet(network, prefix, "ipv6");
}

export function isGloballyRoutableAddress(address: string): boolean {
  const family = NodeNet.isIP(address);
  if (family === 4) {
    return !notGlobalV4.check(address, "ipv4");
  }
  return (
    family === 6 && globalUnicastV6.check(address, "ipv6") && !notGlobalV6.check(address, "ipv6")
  );
}

function normalizedHostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
}

export function inferWebEntryKind(urlString: string): Extract<LibraryEntryKind, "web" | "wechat"> {
  try {
    const parsed = new URL(urlString);
    return parsed.hostname.toLowerCase() === "mp.weixin.qq.com" ? "wechat" : "web";
  } catch {
    return "web";
  }
}

export interface DnsLookupEntry {
  readonly address: string;
  readonly family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<ReadonlyArray<DnsLookupEntry>>;

const defaultDnsResolver: DnsResolver = (hostname) =>
  new Promise((resolve, reject) => {
    NodeDns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        addresses.map((entry) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        })),
      );
    });
  });

export interface FetchWebArticleOptions {
  readonly timeoutMs?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Test seam only: inject DNS resolution without modifying production allowlists. */
  readonly dnsResolver?: DnsResolver | undefined;
  /** Test seam only: override raw hop transport for unit tests without real external network calls. */
  readonly requestHop?:
    | ((input: {
        readonly url: URL;
        readonly pinnedAddress: DnsLookupEntry;
        readonly timeoutMs: number;
        readonly maxBytes: number;
        readonly signal?: AbortSignal | undefined;
      }) => Promise<RawHttpHopResponse>)
    | undefined;
}

export interface RawHttpHopResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: Buffer;
}

export interface FetchedWebArticle {
  readonly finalUrl: string;
  readonly kind: Extract<LibraryEntryKind, "web" | "wechat">;
  readonly title: string;
  readonly body: string;
}

async function resolveAndPinPublicAddress(
  url: URL,
  dnsResolver: DnsResolver,
): Promise<DnsLookupEntry> {
  const host = normalizedHostOf(url);
  const literalFamily = NodeNet.isIP(host);
  if (literalFamily !== 0) {
    if (!isGloballyRoutableAddress(host)) {
      throw new LibrarySsrfRejectedError(host, `${host} is not a globally routable IP address.`);
    }
    return { address: host, family: literalFamily === 6 ? 6 : 4 };
  }

  let resolved: ReadonlyArray<DnsLookupEntry>;
  try {
    resolved = await dnsResolver(host);
  } catch {
    throw new LibrarySsrfRejectedError(host, `${host} could not be resolved.`);
  }
  if (
    resolved.length === 0 ||
    !resolved.every((entry) => isGloballyRoutableAddress(entry.address))
  ) {
    throw new LibrarySsrfRejectedError(host, `${host} resolved to a non-public address.`);
  }
  return resolved[0]!;
}

function performPinnedHttpHop(input: {
  readonly url: URL;
  readonly pinnedAddress: DnsLookupEntry;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<RawHttpHopResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("Web fetch aborted."));
      return;
    }
    const isHttps = input.url.protocol === "https:";
    const transport = isHttps ? NodeHttps : NodeHttp;
    const pinnedLookup: NodeNet.LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [
          { address: input.pinnedAddress.address, family: input.pinnedAddress.family },
        ]);
        return;
      }
      callback(null, input.pinnedAddress.address, input.pinnedAddress.family);
    };

    const req = transport.request(
      input.url,
      {
        method: "GET",
        lookup: pinnedLookup,
        timeout: input.timeoutMs,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
        ...(isHttps ? { servername: normalizedHostOf(input.url) } : {}),
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          res.resume();
          resolve({
            statusCode,
            headers: res.headers,
            body: Buffer.alloc(0),
          });
          return;
        }

        const encoding = String(res.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        const stream: NodeJS.ReadableStream =
          encoding === "gzip"
            ? res.pipe(NodeZlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(NodeZlib.createInflate())
              : encoding === "br"
                ? res.pipe(NodeZlib.createBrotliDecompress())
                : res;

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let finished = false;

        const fail = (err: Error) => {
          if (finished) return;
          finished = true;
          req.destroy();
          reject(err);
        };

        stream.on("data", (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > input.maxBytes) {
            fail(new Error(`Response exceeded ${input.maxBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (err) => fail(err));
        stream.on("end", () => {
          if (finished) return;
          finished = true;
          resolve({
            statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error("Web fetch aborted."));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("timeout", () => {
      req.destroy(new Error(`Web fetch timed out after ${input.timeoutMs}ms.`));
    });
    req.on("error", (err) => {
      input.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.on("close", () => {
      input.signal?.removeEventListener("abort", onAbort);
    });
    req.end();
  });
}

function decodeHtmlEntities(text: string): string {
  return text
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

function extractBalancedElementInnerHtml(html: string, idValue: string): string | null {
  const openPattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\bid\\s*=\\s*["']${idValue}["'][^>]*>`,
    "iu",
  );
  const match = openPattern.exec(html);
  if (!match || match.index === undefined) return null;
  const tagName = match[1]!.toLowerCase();
  const start = match.index + match[0].length;
  const tagPattern = new RegExp(`<(\\/?)${tagName}\\b[^>]*>`, "giu");
  tagPattern.lastIndex = start;
  let depth = 1;
  for (let next = tagPattern.exec(html); next !== null; next = tagPattern.exec(html)) {
    if (next[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, next.index);
      }
    } else if (!next[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return html.slice(start);
}

function extractTagContent(html: string, tagName: string): string | null {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "iu").exec(html);
  return match?.[1] ?? null;
}

function extractMetaContent(html: string, attrValue: string): string | null {
  const p1 = new RegExp(
    `<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']${attrValue}["'][^>]*\\bcontent\\s*=\\s*["']([^"']+)["']`,
    "iu",
  );
  const p2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']+)["'][^>]*\\b(?:property|name)\\s*=\\s*["']${attrValue}["']`,
    "iu",
  );
  return p1.exec(html)?.[1] ?? p2.exec(html)?.[1] ?? null;
}

function htmlFragmentToCleanText(fragment: string): string {
  const stripped = fragment
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(
      /<(script|style|noscript|svg|iframe|template|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/giu,
      " ",
    )
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|pre|tr)>/giu, "\n\n")
    .replace(/<(li)\b[^>]*>/giu, "- ")
    .replace(/<[^>]+>/gu, " ");
  const decoded = decodeHtmlEntities(stripped);
  const normalizedLines = decoded
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/gu, " ").trim());

  const paragraphs: string[] = [];
  let blankPending = false;
  for (const line of normalizedLines) {
    if (line.length === 0) {
      if (paragraphs.length > 0) blankPending = true;
      continue;
    }
    if (blankPending) {
      paragraphs.push("");
      blankPending = false;
    }
    paragraphs.push(line);
  }
  return paragraphs.join("\n").trim();
}

export function extractArticleFromHtml(
  html: string,
  urlString: string,
): { readonly title: string; readonly body: string; readonly wechatBlocked: boolean } {
  const isWeChat = inferWebEntryKind(urlString) === "wechat";
  const wechatBlocked =
    isWeChat &&
    (/wappoc_appmsgcaptcha|secitptpage\/verify/iu.test(html) ||
      (/环境异常/u.test(html) && !/id\s*=\s*["']js_content["']/iu.test(html)));

  const wechatTitleVar = isWeChat
    ? (/\bvar\s+msg_title\s*=\s*['"]([^'"]+)['"]/u.exec(html)?.[1] ?? null)
    : null;
  const rawTitle =
    (isWeChat ? extractBalancedElementInnerHtml(html, "activity-name") : null) ??
    wechatTitleVar ??
    extractMetaContent(html, "og:title") ??
    extractTagContent(html, "title") ??
    urlString;
  const title = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, LIBRARY_MAX_TITLE_CHARS);

  const mainFragment =
    (isWeChat ? extractBalancedElementInnerHtml(html, "js_content") : null) ??
    extractTagContent(html, "article") ??
    extractTagContent(html, "main") ??
    extractTagContent(html, "body") ??
    html;

  const body = htmlFragmentToCleanText(mainFragment).slice(0, LIBRARY_MAX_BODY_CHARS);
  return {
    title: title || urlString.slice(0, LIBRARY_MAX_TITLE_CHARS),
    body,
    wechatBlocked,
  };
}

/**
 * Fetches a web or WeChat article with strict hop-by-hop DNS resolution & pinned IP sockets.
 * Throws `LibraryValidationError` for malformed/disallowed URLs and `LibrarySsrfRejectedError`
 * for any private/loopback/link-local/unresolvable host (including redirect targets).
 */
export async function fetchWebArticle(
  rawUrl: string,
  options: FetchWebArticleOptions = {},
): Promise<FetchedWebArticle> {
  const normalizedUrl = normalizeLibraryUrl(rawUrl);
  if (normalizedUrl === null) {
    throw new LibraryValidationError("url", "A valid http or https URL is required.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const dnsResolver = options.dnsResolver ?? defaultDnsResolver;
  const requestHop = options.requestHop ?? performPinnedHttpHop;

  let currentUrl = new URL(normalizedUrl);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const pinnedAddress = await resolveAndPinPublicAddress(currentUrl, dnsResolver);
    const response = await requestHop({
      url: currentUrl,
      pinnedAddress,
      timeoutMs,
      maxBytes,
      signal: options.signal,
    });

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) {
        throw new Error(`HTTP ${response.statusCode} redirect missing Location header.`);
      }
      if (hop === maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit (${maxRedirects}).`);
      }
      const resolvedNext = new URL(location, currentUrl).toString();
      const validatedNext = normalizeLibraryUrl(resolvedNext);
      if (validatedNext === null) {
        throw new LibraryValidationError("url", "Redirect target URL is not allowed.");
      }
      currentUrl = new URL(validatedNext);
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Remote server returned HTTP ${response.statusCode}.`);
    }

    const contentTypeHeader = response.headers["content-type"];
    const contentType = (
      Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : (contentTypeHeader ?? "")
    ).toLowerCase();
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
    const isPlainText =
      contentType.includes("text/plain") ||
      contentType.includes("text/markdown") ||
      contentType === "";
    if (!isHtml && !isPlainText) {
      throw new Error(
        `Unsupported content type for web article fetch: ${contentType || "unknown"}`,
      );
    }

    const text = response.body.toString("utf8");
    const finalUrl = currentUrl.toString();
    const kind = inferWebEntryKind(finalUrl);

    if (isPlainText && !isHtml) {
      return {
        finalUrl,
        kind,
        title: currentUrl.hostname,
        body: text
          .replace(/\u0000/gu, "")
          .trim()
          .slice(0, LIBRARY_MAX_BODY_CHARS),
      };
    }

    const extracted = extractArticleFromHtml(text, finalUrl);
    if (extracted.wechatBlocked) {
      throw new Error("WeChat article requires interactive verification; saved link only.");
    }
    if (extracted.body.length === 0) {
      throw new Error("Could not extract readable text from page.");
    }
    return {
      finalUrl,
      kind,
      title: extracted.title,
      body: extracted.body,
    };
  }

  throw new Error("Redirect loop aborted.");
}
