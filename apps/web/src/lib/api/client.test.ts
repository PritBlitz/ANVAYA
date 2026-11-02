import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { createEndpoints } from "./endpoints";
import { ApiError, CLIENT_ERROR_CODES, describeError } from "./errors";
import { HttpTransport } from "./http-transport";
import { retryDelay, shouldRetryQuery } from "./query-client";
import {
  buildQueryString,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./transport";

function fakeTransport(respond: (req: TransportRequest) => TransportResponse) {
  const calls: TransportRequest[] = [];
  const transport: Transport = {
    kind: "http",
    request: async (req) => {
      calls.push(req);
      return respond(req);
    },
    openEventStream: () => () => {},
  };
  return { transport, calls };
}

describe("ApiClient", () => {
  it("unwraps the success envelope and sends correlation + scope headers", async () => {
    const { transport, calls } = fakeTransport(() => ({
      status: 200,
      body: { data: { ok: 1 }, meta: { request_id: "req_1" } },
      requestId: "req_1",
    }));
    const client = new ApiClient(transport);
    client.setWorkspace("ws-1");
    await expect(client.post("/x", { a: 1 }, { idempotencyKey: "k1" })).resolves.toEqual({ ok: 1 });
    expect(calls[0]!.headers["X-Workspace-Id"]).toBe("ws-1");
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("k1");
    expect(calls[0]!.headers["X-Request-Id"]).toMatch(/.+/);
  });

  it("throws ApiError from the error envelope", async () => {
    const { transport } = fakeTransport(() => ({
      status: 409,
      body: {
        error: {
          code: "INVALID_STATE_TRANSITION",
          message: "Not now.",
          details: { fields: { title: "Too short" } },
        },
        meta: { request_id: "req_9" },
      },
      requestId: null,
    }));
    const err = await new ApiClient(transport).get("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: "INVALID_STATE_TRANSITION",
      requestId: "req_9",
    });
    expect((err as ApiError).isConflict).toBe(true);
    expect((err as ApiError).fieldErrors).toEqual({ title: "Too short" });
  });

  it("rejects responses that don't match the envelope", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      body: { nope: true },
      requestId: null,
    }));
    await expect(new ApiClient(transport).get("/x")).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.invalidResponse,
    });
  });

  it("handles 204 and non-envelope errors", async () => {
    const { transport } = fakeTransport((r) =>
      r.method === "DELETE"
        ? { status: 204, body: null, requestId: null }
        : { status: 500, body: null, requestId: null },
    );
    const client = new ApiClient(transport);
    await expect(client.delete("/x")).resolves.toBeUndefined();
    await expect(client.get("/x")).rejects.toMatchObject({ status: 500, code: "HTTP_500" });
  });

  it("loads a lazy transport once", async () => {
    const loader = vi.fn(
      async () =>
        fakeTransport(() => ({ status: 200, body: { data: 1 }, requestId: null })).transport,
    );
    const client = new ApiClient(loader);
    await client.get("/a");
    await client.get("/b");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("maps list endpoints to pages using meta.page", async () => {
    const wireTask = {
      id: "1",
      workspace_id: "w",
      repository_id: "r",
      created_by: "u",
      source_type: "manual",
      external_number: null,
      title: "T",
      description: "D",
      status: "open",
      labels: [],
      created_at: "2026-11-02T00:00:00Z",
      updated_at: "2026-11-02T00:00:00Z",
      latest_run: null,
      repository_full_name: "acme/api",
    };
    const { transport, calls } = fakeTransport(() => ({
      status: 200,
      body: { data: [wireTask], meta: { page: { next_cursor: "abc", has_more: true } } },
      requestId: null,
    }));
    const client = new ApiClient(transport);
    client.setWorkspace("w");
    const api = createEndpoints(client);
    const page = await api.tasks.list({ limit: 25, status: "open" });
    expect(page.next_cursor).toBe("abc");
    expect(page.items[0]).toMatchObject({
      id: "1",
      repository_full_name: "acme/api",
      latest_run: null,
    });
    expect(calls[0]!.query).toMatchObject({ limit: 25, status: "open", workspace_id: "w" });
    await api.repositories.get("a/b");
    expect(calls[1]!.path).toBe("/repositories/a%2Fb");
  });
});

describe("buildQueryString", () => {
  it("skips empty values and repeats arrays", () => {
    expect(buildQueryString({ a: 1, b: undefined, c: "", d: ["x", "y"], e: false })).toBe(
      "?a=1&d=x&d=y&e=false",
    );
    expect(buildQueryString({})).toBe("");
  });
});

describe("HttpTransport", () => {
  it("sends credentials, JSON and the CSRF header on mutations", async () => {
    document.cookie = "anvaya_csrf=tok123";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 201,
          headers: { "X-Request-Id": "srv" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await new HttpTransport("/api/v1").request({
      method: "POST",
      path: "/tasks",
      body: { a: 1 },
      headers: { "X-Request-Id": "cli" },
    });
    expect(res).toMatchObject({ status: 201, requestId: "srv" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/tasks");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok123");
    vi.unstubAllGlobals();
  });

  it("turns fetch failures into NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(
      new HttpTransport("/api/v1").request({ method: "GET", path: "/me", headers: {} }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.network });
    vi.unstubAllGlobals();
  });
});

describe("retry policy", () => {
  const err = (status: number, code = "X", details = {}) =>
    new ApiError({ status, code, message: "m", details });

  it("retries only transient failures, at most twice", () => {
    expect(shouldRetryQuery(0, err(503))).toBe(true);
    expect(shouldRetryQuery(0, err(0, CLIENT_ERROR_CODES.network))).toBe(true);
    expect(shouldRetryQuery(0, err(404))).toBe(false);
    expect(shouldRetryQuery(0, err(422))).toBe(false);
    expect(shouldRetryQuery(2, err(503))).toBe(false);
    expect(shouldRetryQuery(0, new Error("x"))).toBe(false);
  });

  it("honours retry_after on 429", () => {
    expect(retryDelay(0, err(429, "RATE", { retry_after_seconds: 3 }))).toBe(3000);
    expect(retryDelay(2, err(503))).toBe(4000);
  });

  it("describes errors safely", () => {
    expect(describeError(err(403)).title).toBe("You don't have access");
    expect(
      describeError(new ApiError({ status: 502, code: "UPSTREAM", message: "" })).description,
    ).toMatch(/No paid fallback/);
    expect(describeError(err(502)).description).toBe("m"); // server message wins when present
    expect(describeError(new Error("secret stack")).description).not.toMatch(/secret/);
  });

  it("explains hosted-provider outcomes without implying a fallback (B-1)", () => {
    const refused = describeError(
      new ApiError({ status: 422, code: "PROVIDER_REFUSED", message: "x" }),
    );
    expect(refused.title).toMatch(/declined/);
    expect(refused.description).toMatch(/Nothing was retried on another provider/);
    expect(
      describeError(new ApiError({ status: 429, code: "PROVIDER_RATE_LIMITED", message: "x" }))
        .title,
    ).toMatch(/rate limiting/);
    expect(
      describeError(new ApiError({ status: 504, code: "PROVIDER_TIMEOUT", message: "x" }))
        .description,
    ).toMatch(/request timeout/);
  });
});
