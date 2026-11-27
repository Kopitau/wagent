import { LibraryValidationError } from "./errors.ts";
import {
  LIBRARY_ENTRY_KINDS,
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_DRAFT_QUESTION_CHARS,
  LIBRARY_MAX_FILENAME_CHARS,
  LIBRARY_MAX_NOTE_CHARS,
  LIBRARY_MAX_QUERY_CHARS,
  LIBRARY_MAX_TAG_CHARS,
  LIBRARY_MAX_TAGS,
  LIBRARY_MAX_TITLE_CHARS,
  LIBRARY_MAX_URL_CHARS,
  type LibraryEntryKind,
} from "./types.ts";

const ALLOWED_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const VALID_KINDS: ReadonlySet<string> = new Set(LIBRARY_ENTRY_KINDS);

export function validateLibraryKind(kind: string): LibraryEntryKind {
  if (!VALID_KINDS.has(kind)) {
    throw new LibraryValidationError("kind", `Unsupported library entry kind: ${kind}`);
  }
  return kind as LibraryEntryKind;
}

export function normalizeLibraryTitle(rawTitle: string): string {
  const title = rawTitle.replace(/\r?\n/gu, " ").trim();
  if (title.length === 0) {
    throw new LibraryValidationError("title", "Title must not be empty.");
  }
  if (title.length > LIBRARY_MAX_TITLE_CHARS) {
    throw new LibraryValidationError(
      "title",
      `Title must be at most ${LIBRARY_MAX_TITLE_CHARS} characters.`,
    );
  }
  return title;
}

export function normalizeLibraryUrl(rawUrl: string | null | undefined): string | null {
  if (rawUrl === undefined || rawUrl === null) return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > LIBRARY_MAX_URL_CHARS) {
    throw new LibraryValidationError(
      "url",
      `URL must be at most ${LIBRARY_MAX_URL_CHARS} characters.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LibraryValidationError("url", "URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LibraryValidationError("url", "URL must use the http or https protocol.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new LibraryValidationError("url", "URL must not contain embedded credentials.");
  }
  // WHATWG URL normalizes default ports (80/443) to empty string, so any non-empty port is custom.
  if (parsed.port !== "") {
    throw new LibraryValidationError("url", "URL must not specify a custom port.");
  }
  if (parsed.hostname.length === 0) {
    throw new LibraryValidationError("url", "URL must include a hostname.");
  }
  const normalized = parsed.toString();
  if (normalized.length > LIBRARY_MAX_URL_CHARS) {
    throw new LibraryValidationError(
      "url",
      `URL must be at most ${LIBRARY_MAX_URL_CHARS} characters.`,
    );
  }
  return normalized;
}

export function normalizeLibraryBody(rawBody: string | undefined): string {
  const body = rawBody ?? "";
  if (body.includes("\u0000")) {
    throw new LibraryValidationError("body", "Body must not contain NUL bytes.");
  }
  if (body.length > LIBRARY_MAX_BODY_CHARS) {
    throw new LibraryValidationError(
      "body",
      `Body must be at most ${LIBRARY_MAX_BODY_CHARS} characters.`,
    );
  }
  return body;
}

export function normalizeLibraryNote(rawNote: string | undefined): string {
  const note = rawNote ?? "";
  if (note.includes("\u0000")) {
    throw new LibraryValidationError("note", "Note must not contain NUL bytes.");
  }
  if (note.length > LIBRARY_MAX_NOTE_CHARS) {
    throw new LibraryValidationError(
      "note",
      `Note must be at most ${LIBRARY_MAX_NOTE_CHARS} characters.`,
    );
  }
  return note;
}

export function normalizeLibraryTags(
  rawTags: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!rawTags || rawTags.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of rawTags) {
    const tag = raw.replace(/\s+/gu, " ").trim();
    if (tag.length === 0) continue;
    if (tag.length > LIBRARY_MAX_TAG_CHARS) {
      throw new LibraryValidationError(
        "tags",
        `Each tag must be at most ${LIBRARY_MAX_TAG_CHARS} characters.`,
      );
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
    if (normalized.length > LIBRARY_MAX_TAGS) {
      throw new LibraryValidationError("tags", `At most ${LIBRARY_MAX_TAGS} tags are allowed.`);
    }
  }
  return normalized;
}

export function normalizeLibraryQuery(rawQuery: string | undefined): string {
  if (!rawQuery) return "";
  const trimmed = rawQuery.trim();
  if (trimmed.length > LIBRARY_MAX_QUERY_CHARS) {
    throw new LibraryValidationError(
      "query",
      `Search query must be at most ${LIBRARY_MAX_QUERY_CHARS} characters.`,
    );
  }
  return trimmed;
}

export function normalizeDraftQuestion(rawQuestion: string): string {
  const question = rawQuestion.trim();
  if (question.length === 0) {
    throw new LibraryValidationError("question", "Question must not be empty.");
  }
  if (question.length > LIBRARY_MAX_DRAFT_QUESTION_CHARS) {
    throw new LibraryValidationError(
      "question",
      `Question must be at most ${LIBRARY_MAX_DRAFT_QUESTION_CHARS} characters.`,
    );
  }
  return question;
}

export function validateTextImportFile(input: {
  readonly fileName: string;
  readonly content: string;
  readonly title?: string | undefined;
}): { readonly title: string; readonly body: string } {
  const baseName = input.fileName.trim().split(/[\\/]/u).pop() ?? "";
  if (baseName.length === 0 || baseName.length > LIBRARY_MAX_FILENAME_CHARS) {
    throw new LibraryValidationError("fileName", "File name is invalid.");
  }
  const dotIndex = baseName.lastIndexOf(".");
  const ext = dotIndex > 0 ? baseName.slice(dotIndex).toLowerCase() : "";
  if (!ALLOWED_TEXT_EXTENSIONS.has(ext)) {
    throw new LibraryValidationError(
      "fileName",
      "Only UTF-8 Markdown (.md, .markdown) and plain text (.txt) files are supported.",
    );
  }
  if (input.content.includes("\u0000")) {
    throw new LibraryValidationError("content", "File content must be valid UTF-8 text.");
  }
  const body = normalizeLibraryBody(input.content);
  const derivedTitle =
    input.title?.trim() ||
    extractHeadingTitle(body, ext) ||
    baseName.slice(0, dotIndex).trim() ||
    baseName;
  return {
    title: normalizeLibraryTitle(derivedTitle),
    body,
  };
}

export function decodeUtf8TextBytes(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new LibraryValidationError("content", "File content must be valid UTF-8 text.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LibraryValidationError("content", "File content must be valid UTF-8 text.");
  }
}

function extractHeadingTitle(body: string, ext: string): string | null {
  if (ext !== ".md" && ext !== ".markdown") return null;
  for (const line of body.split(/\r?\n/u).slice(0, 20)) {
    const match = /^#\s+(.+)$/u.exec(line.trim());
    if (match?.[1]) {
      const candidate = match[1].trim();
      if (candidate.length > 0 && candidate.length <= LIBRARY_MAX_TITLE_CHARS) {
        return candidate;
      }
    }
  }
  return null;
}
