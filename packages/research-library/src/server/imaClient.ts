import { LibrarySsrfRejectedError, LibraryValidationError } from "../errors.ts";
import type { ImaSearchHit } from "../types.ts";

export interface ImaSearchOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly knowledgeBaseId: string;
  readonly query: string;
  readonly limit?: number | undefined;
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
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1"
  ) {
    throw new LibrarySsrfRejectedError(host, "Refused to connect ima to a non-public host.");
  }
  return parsed;
}

/**
 * Queries a configured Tencent `ima` knowledge base endpoint using server-resolved credentials.
 * Credentials are never supplied by client search requests.
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
  const fetchImpl = options.fetchImpl ?? fetch;

  const endpoint = new URL(
    baseUrl.pathname.endsWith("/search")
      ? baseUrl.pathname
      : `${baseUrl.pathname.replace(/\/+$/u, "")}/search`,
    baseUrl.origin,
  );

  const response = await fetchImpl(endpoint.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      knowledge_base_id: options.knowledgeBaseId.trim(),
      query,
      limit,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`ima search returned HTTP ${response.status}`);
  }

  const raw = (await response.json()) as {
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
