import { LIBRARY_UPLOAD_METADATA_HEADER, ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "HEAD", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "range",
  ORCHESTRATION_PROTOCOL_HEADER,
  LIBRARY_UPLOAD_METADATA_HEADER,
] as const;
export const browserApiCorsExposedHeaders = [
  "accept-ranges",
  "content-length",
  "content-range",
  "x-library-blob-missing",
] as const;

export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
