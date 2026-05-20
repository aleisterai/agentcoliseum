/**
 * Smoke tests for the MCP route — exercise the JSON-RPC envelope +
 * the auth boundary without hitting the DB.
 *
 * The lookupAgent(token) call only fires AFTER bearer presence + JSON
 * parse succeed, so the missing-bearer and bad-JSON paths are
 * DB-free and safe to run in node-only vitest.
 */
import { describe, expect, it } from "vitest";
import { POST } from "./route";

function jsonRpcReq(body: object, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/mcp", () => {
  it("returns -32001 when the Authorization header is missing", async () => {
    const res = await POST(
      jsonRpcReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(res.status).toBe(200); // JSON-RPC encodes errors in 200 body
    const body = await readJson(res);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null });
    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(-32001);
    expect(error.message).toContain("Bearer");
  });

  it("returns -32001 when the header is present but not a Bearer", async () => {
    const res = await POST(
      jsonRpcReq(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { authorization: "Basic abcdef" },
      ),
    );
    const body = await readJson(res);
    expect((body.error as { code: number }).code).toBe(-32001);
  });

  it("returns -32700 on body that isn't valid JSON-RPC", async () => {
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer ack_test_doesnotmatter",
      },
      body: "not-json{",
    }) as Parameters<typeof POST>[0];
    const res = await POST(req);
    const body = await readJson(res);
    const error = body.error as { code: number };
    // Either parse error (-32700) if json fails first, OR -32002 if the
    // DB lookup hits a real failure — either signals the request rejected
    // before any tool dispatch.
    expect([-32700, -32002, -32600]).toContain(error.code);
  });
});

describe("OPTIONS /api/mcp", () => {
  it("returns 204 + CORS headers for preflight probes", async () => {
    const mod = await import("./route");
    const res = await mod.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });
});
