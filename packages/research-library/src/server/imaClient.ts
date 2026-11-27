// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- DNS-pinned HTTPS transport prevents SSRF and cross-origin Bearer redirect leaks.
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import { LibrarySsrfRejectedError, LibraryValidationError } from "../errors.ts";
import type { ImaSearchHit } from "../types.ts";
import {
  defaultDnsResolver,
  isGloballyRoutableAddress,
  resolveAndPinPublicAddress,
  type DnsLookupEntry,
  type DnsResolver,
} from "./webFetch.ts";

const DEFAULT_IMA_TIMEOUT_MS = 15_000;
const MAX_IMA_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ImaSearchOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly knowledgeBaseId: string;
  readonly query: string;
  readonly limit?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly dnsResolver?: DnsResolver | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

function validateImaBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new LibraryValidationError("baseUrl", "ima baseUrl must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new LibrarySsrfRejectedError(
      parsed.hostname || raw,
      "ima knowledge base endpoint must use HTTPS.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new LibraryValidationError("baseUrl", "ima baseUrl must not include URL credentials.");
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    throw new LibrarySsrfRejectedError(host, "Refused to connect ima to a non-public host.");
  }
  if (NodeNet.isIP(host) !== 0 && !isGloballyRoutableAddress(host)) {
    throw new LibrarySsrfRejectedError(host, "Refused to connect ima to a non-public IP address.");
  }
  return parsed;
}

function postPinnedHttpsJson(input: {
  readonly url: URL;
  readonly pinnedAddress: DnsLookupEntry;
  readonly apiKey: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("ima search aborted."));
      return;
    }
    let settled = false;
    const servername = input.url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
    const pinnedLookup: NodeNet.LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [
          { address: input.pinnedAddress.address, family: input.pinnedAddress.family },
        ]);
        return;
      }
      callback(null, input.pinnedAddress.address, input.pinnedAddress.family);
    };

    const cleanup = () => {
      clearTimeout(hardTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const settleResolve = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const req = NodeHttps.request(
      input.url,
      {
        method: "POST",
        lookup: pinnedLookup,
        servername,
        timeout: input.timeoutMs,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
          "content-length": String(Buffer.byteLength(input.body, "utf8")),
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          res.destroy();
          settleReject(
            new LibrarySsrfRejectedError(
              servername,
              `Refused to follow HTTP ${statusCode} redirect from ima endpoint.`,
            ),
          );
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.destroy();
          settleReject(new Error(`ima search returned HTTP ${statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_IMA_RESPONSE_BYTES) {
            req.destroy();
            settleReject(
              new Error(`ima search response exceeded ${MAX_IMA_RESPONSE_BYTES} bytes.`),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => settleReject(err));
        res.on("end", () => settleResolve(Buffer.concat(chunks).toString("utf8")));
      },
    );

    const hardTimer = setTimeout(() => {
      const err = new Error(`ima search timed out after ${input.timeoutMs}ms.`);
      req.destroy(err);
      settleReject(err);
    }, input.timeoutMs);
    hardTimer.unref?.();

    const onAbort = () => {
      const err = new Error("ima search aborted.");
      req.destroy(err);
      settleReject(err);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("timeout", () => {
      const err = new Error(`ima search timed out after ${input.timeoutMs}ms.`);
      req.destroy(err);
      settleReject(err);
    });
    req.on("error", (err) => settleReject(err));
    req.on("close", cleanup);
    req.end(input.body, "utf8");
  });
}

/**
 * Queries a configured Tencent `ima` knowledge base endpoint using server-resolved credentials.
 * Enforces DNS public-address pinning and refuses HTTP redirects so Bearer tokens never leak cross-origin.
 */
export async function searchImaKnowledgeBase(
  options: ImaSearchOptions,
): Promise<ReadonlyArray<ImaSearchHit>> {
  const baseUrl = validateImaBaseUrl(options.baseUrl);
  const query = options.query.trim();
  if (!query) {
    throw new LibraryValidationError("query", "Search query must not be empty.");
  }
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new LibraryValidationError("apiKey", "ima API key is not configured.");
  }
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 10)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMA_TIMEOUT_MS;

  const normalizedPath = baseUrl.pathname.endsWith("/search")
    ? baseUrl.pathname
    : `${baseUrl.pathname.replace(/\/+$/u, "")}/search`;
  const endpoint = new URL(normalizedPath, baseUrl.origin);
  const requestBody = JSON.stringify({
    knowledge_base_id: options.knowledgeBaseId.trim(),
    query,
    limit,
  });

  let rawText: string;
  if (options.fetchImpl) {
    if (options.dnsResolver) {
      await resolveAndPinPublicAddress(endpoint, options.dnsResolver);
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await options.fetchImpl(endpoint.toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new LibrarySsrfRejectedError(
        endpoint.hostname,
        `Refused to follow HTTP ${response.status} redirect from ima endpoint.`,
      );
    }
    if (!response.ok) {
      throw new Error(`ima search returned HTTP ${response.status}`);
    }
    rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > MAX_IMA_RESPONSE_BYTES) {
      throw new Error(`ima search response exceeded ${MAX_IMA_RESPONSE_BYTES} bytes.`);
    }
  } else {
    const pinnedAddress = await resolveAndPinPublicAddress(
      endpoint,
      options.dnsResolver ?? defaultDnsResolver,
    );
    rawText = await postPinnedHttpsJson({
      url: endpoint,
      pinnedAddress,
      apiKey,
      body: requestBody,
      timeoutMs,
      signal: options.signal,
    });
  }

  const raw = JSON.parse(rawText) as {
    readonly items?: ReadonlyArray<Record<string, unknown>>;
    readonly results?: ReadonlyArray<Record<string, unknown>>;
    readonly data?: { readonly items?: ReadonlyArray<Record<string, unknown>> };
  };

  const list = raw.items ?? raw.results ?? raw.data?.items ?? [];
  return list.slice(0, limit).map((item, idx) => ({
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `ima-${idx + 1}`,
    title:
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim().slice(0, 300)
        : "Untitled ima document",
    snippet:
      typeof item.snippet === "string"
        ? item.snippet.slice(0, 1000)
        : typeof item.content === "string"
          ? item.content.slice(0, 1000)
          : "",
    url: typeof item.url === "string" && item.url.trim() ? item.url.trim() : null,
    score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
  }));
}
