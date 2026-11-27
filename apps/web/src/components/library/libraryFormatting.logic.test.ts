import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLibraryUrlHost,
  formatTagsInput,
  parseTagsInput,
  readUtf8TextImportFile,
  resolveActiveLibraryEnvironmentId,
  toggleDraftSelection,
} from "./libraryFormatting.logic";

describe("libraryFormatting.logic", () => {
  it("parses and deduplicates tags across ASCII and Chinese commas", () => {
    expect(parseTagsInput("ML, transformers，ml,  Quantum  ,")).toEqual([
      "ML",
      "transformers",
      "Quantum",
    ]);
    expect(formatTagsInput(["ML", "Quantum"])).toBe("ML, Quantum");
  });

  it("caps multi-selection at 5 items and toggles existing items off", () => {
    let selected: ReadonlyArray<string> = [];
    for (const id of ["1", "2", "3", "4", "5", "6"]) {
      selected = toggleDraftSelection(selected, id);
    }
    expect(selected).toEqual(["1", "2", "3", "4", "5"]);
    expect(toggleDraftSelection(selected, "3")).toEqual(["1", "2", "4", "5"]);
  });

  it("prefers explicit selection, then requested env, then connected supporting env", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const envs = [
      { environmentId: envA, supportsLibrary: false, connected: true },
      { environmentId: envB, supportsLibrary: true, connected: true },
    ];
    expect(resolveActiveLibraryEnvironmentId(envs, null, undefined)).toBe(envB);
    expect(resolveActiveLibraryEnvironmentId(envs, envA, envB)).toBe(envA);
    expect(resolveActiveLibraryEnvironmentId(envs, null, envA)).toBe(envA);
    expect(formatLibraryUrlHost("https://arxiv.org/abs/1706.03762")).toBe("arxiv.org");
  });

  it("rejects non-UTF-8 or unsupported file imports before hitting RPC", async () => {
    const validFile = new File(["# Hello\n\nBody text"], "notes.md", { type: "text/markdown" });
    expect(await readUtf8TextImportFile(validFile)).toEqual({
      ok: true,
      fileName: "notes.md",
      content: "# Hello\n\nBody text",
    });

    const invalidExt = new File(["binary"], "paper.pdf", { type: "application/pdf" });
    const extResult = await readUtf8TextImportFile(invalidExt);
    expect(extResult.ok).toBe(false);

    const invalidUtf8 = new File([new Uint8Array([0xff, 0xfe, 0x00])], "bad.txt");
    const utf8Result = await readUtf8TextImportFile(invalidUtf8);
    expect(utf8Result.ok).toBe(false);
  });
});
