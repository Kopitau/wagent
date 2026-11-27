import type { EnvironmentId, LibraryEntryKind } from "@t3tools/contracts";
import {
  LIBRARY_MAX_DRAFT_ITEMS,
  decodeUtf8TextBytes,
  validateTextImportFile,
} from "@t3tools/research-library";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

export function parseTagsInput(raw: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[,，]/u)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
  }
  return tags;
}

export function formatTagsInput(tags: ReadonlyArray<string>): string {
  return tags.join(", ");
}

export function toggleDraftSelection(
  current: ReadonlyArray<string>,
  entryId: string,
): ReadonlyArray<string> {
  if (current.includes(entryId)) {
    return current.filter((id) => id !== entryId);
  }
  if (current.length >= LIBRARY_MAX_DRAFT_ITEMS) {
    return current;
  }
  return [...current, entryId];
}

export function formatLibraryUrlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function resolveActiveLibraryEnvironmentId(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly supportsLibrary: boolean;
    readonly connected: boolean;
  }>,
  selected: EnvironmentId | null | undefined,
  requested: EnvironmentId | null | undefined,
): EnvironmentId | null {
  if (selected && environments.some((env) => env.environmentId === selected)) {
    return selected;
  }
  if (requested && environments.some((env) => env.environmentId === requested)) {
    return requested;
  }
  const connectedSupporting = environments.find((env) => env.supportsLibrary && env.connected);
  if (connectedSupporting) return connectedSupporting.environmentId;
  const anySupporting = environments.find((env) => env.supportsLibrary);
  if (anySupporting) return anySupporting.environmentId;
  return environments[0]?.environmentId ?? null;
}

export type TextFileDecodeResult =
  | { readonly ok: true; readonly fileName: string; readonly content: string }
  | { readonly ok: false; readonly message: string };

export async function readUtf8TextImportFile(file: File): Promise<TextFileDecodeResult> {
  try {
    const buffer = await file.arrayBuffer();
    const content = decodeUtf8TextBytes(new Uint8Array(buffer));
    validateTextImportFile({ fileName: file.name, content });
    return { ok: true, fileName: file.name, content };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : m(msg("Could not read UTF-8 text file.")),
    };
  }
}

export function isLinkEntryKind(kind: LibraryEntryKind): boolean {
  return kind === "web" || kind === "wechat";
}
