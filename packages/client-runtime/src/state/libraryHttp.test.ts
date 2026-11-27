import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchEnvironmentLibraryPdfBytes, uploadEnvironmentLibraryPdf } from "./libraryHttp.ts";

const ENV_ID = EnvironmentId.make("env-remote-dpop");

function makeSupervisorLayer(prepared: PreparedConnection) {
  return Layer.effect(
    EnvironmentSupervisor.EnvironmentSupervisor,
    Effect.gen(function* () {
      const preparedRef = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
        Option.some(prepared),
      );
      return {
        target: prepared.target,
        prepared: preparedRef,
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    }),
  );
}

it.effect("authenticates PDF downloads and uploads with DPoP signing and 401 token renewal", () =>
  Effect.gen(function* () {
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly authorization: string | null;
      readonly dpop: string | null;
    }> = [];
    let attempt = 0;

    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        dpop: headers.get("dpop"),
      });

      if (url.includes("/api/library/items/")) {
        attempt += 1;
        if (attempt === 1) {
          return new Response("expired", { status: 401 });
        }
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": "5",
          },
        });
      }

      return new Response(
        JSON.stringify({
          entry: {
            id: "entry-pdf-1",
            kind: "pdf",
            title: "Uploaded Paper",
            url: null,
            body: "[p.1]\nHello",
            note: "",
            tags: ["ai"],
            blobSha256: "a".repeat(64),
            blobBytes: 5,
            blobMissing: false,
            pageCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            revision: 1,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    const prepared: PreparedConnection = {
      environmentId: ENV_ID,
      httpBaseUrl: "https://env-a.t3connect.test",
      wsUrl: "wss://env-a.t3connect.test/ws",
      httpAuthorization: { _tag: "Dpop", accessToken: "stale-token" },
      target: {
        _tag: "RelayConnectionTarget",
        environmentId: ENV_ID,
      },
    } as unknown as PreparedConnection;

    const layer = Layer.mergeAll(
      makeSupervisorLayer(prepared),
      Layer.succeed(FetchHttpClient.Fetch, fakeFetch),
      Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({
        createProof: ({ method, url, accessToken }) =>
          Effect.succeed(`proof:${method}:${url}:${accessToken}`),
      }),
      Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
        authorizeDpopHttp: ({ rejectedAccessToken }) =>
          Effect.succeed({
            httpBaseUrl: "https://env-a.t3connect.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: rejectedAccessToken ? "fresh-token" : "stale-token",
            },
          } as unknown as Effect.Success<
            ReturnType<
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]
            >
          >),
      }),
    );

    const bytes = yield* fetchEnvironmentLibraryPdfBytes({ entryId: "entry-pdf-1" }).pipe(
      Effect.provide(layer),
    );
    expect(bytes.byteLength).toBe(5);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("DPoP stale-token");
    expect(requests[1]?.authorization).toBe("DPoP fresh-token");
    expect(requests[1]?.dpop).toContain(
      "proof:GET:https://env-a.t3connect.test/api/library/items/entry-pdf-1/pdf:fresh-token",
    );

    const uploaded = yield* uploadEnvironmentLibraryPdf({
      fileName: "paper.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      title: "Uploaded Paper",
      tags: ["ai"],
    }).pipe(Effect.provide(layer));
    expect(uploaded.id).toBe("entry-pdf-1");
    expect(requests[2]?.method).toBe("POST");
    expect(requests[2]?.url).toContain("/api/library/upload?fileName=paper.pdf");
  }),
);

it.effect("surfaces blob_missing when server returns X-Library-Blob-Missing header", () =>
  Effect.gen(function* () {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response("missing", {
        status: 404,
        headers: { "x-library-blob-missing": "1" },
      });

    const prepared: PreparedConnection = {
      environmentId: ENV_ID,
      httpBaseUrl: "http://127.0.0.1:3773",
      wsUrl: "ws://127.0.0.1:3773/ws",
      httpAuthorization: null,
      target: {
        _tag: "LocalConnectionTarget",
        environmentId: ENV_ID,
      },
    } as unknown as PreparedConnection;

    const layer = Layer.mergeAll(
      makeSupervisorLayer(prepared),
      Layer.succeed(FetchHttpClient.Fetch, fakeFetch),
    );

    const error = yield* fetchEnvironmentLibraryPdfBytes({ entryId: "missing-1" }).pipe(
      Effect.flip,
      Effect.provide(layer),
    );
    expect(error._tag).toBe("LibraryPdfHttpError");
    if (error._tag === "LibraryPdfHttpError") {
      expect(error.code).toBe("blob_missing");
    }
  }),
);
