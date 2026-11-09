// Failure modes: starting the hub leaves no HTTP MCP endpoint; clients inherit the server's owner key; worker or revoked
// keys control workflows; a source escapes its own identity; browser origins reach management tools; malformed or oversized
// input is executed; HTTP notifications get JSON-RPC replies; the transport silently requires SSE or server-side sessions.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { versionName } from "../host/version.ts";
import { setup } from "./helpers.ts";

setup("mcp-http");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const keys = {
  owner: hub.addKey("owner", "me"),
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
const server = serve(0);
let base = "";
before(async () => {
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const message = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params !== undefined && { params }),
});
const headers = (key: string) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
});
function post(body: unknown, key = keys.owner, extra: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers(key), ...extra },
    body: JSON.stringify(body),
  });
}
async function tool(name: string, args = {}, key = keys.owner) {
  const response = await post(message("tools/call", { name, arguments: args }), key);
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.ok(!rpc.error, JSON.stringify(rpc.error));
  assert.ok(!rpc.result.isError, JSON.stringify(rpc.result));
  return JSON.parse(rpc.result.content[0].text);
}

test("the running hub serves stateless MCP initialization, notifications and JSON responses on the same port", async () => {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: headers(keys.owner),
    body: JSON.stringify(
      message("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1" },
      }),
    ),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const initialized = await response.json();
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.equal(initialized.result.serverInfo.version, versionName());
  const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  const clientResponse = await post({ jsonrpc: "2.0", id: 8, result: {} });
  assert.equal(clientResponse.status, 202);
  assert.deepEqual((await (await post(message("ping"))).json()).result, {});
  for (const method of ["GET", "DELETE"]) {
    const unsupported = await fetch(`${base}/mcp`, { method, headers: headers(keys.owner) });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "POST");
  }
});

test("HTTP MCP uses only the caller's kind of key, and rechecks revocation on the next request", async () => {
  for (const key of ["", "made-up", keys.worker, keys.channel]) {
    const response = await post(message("tools/list"), key);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /Bearer/);
  }
  const ownerTools = (await (await post(message("tools/list"))).json()).result.tools.map((entry: any) => entry.name);
  assert.ok(ownerTools.includes("workflow_start"));
  assert.ok(!ownerTools.includes("emit"));
  const sourceTools = (await (await post(message("tools/list"), keys.source)).json()).result.tools;
  assert.deepEqual(
    sourceTools.map((entry: any) => entry.name),
    ["emit", "tell"],
  );
  const denied = await post(message("tools/call", { name: "status" }), keys.source);
  assert.equal((await denied.json()).error.code, -32602);
  const disposable = hub.addKey("owner", "disposable");
  assert.equal((await post(message("ping"), disposable)).status, 200);
  hub.removeKey("owner", "disposable");
  assert.equal((await post(message("ping"), disposable)).status, 401);
});

test("owner MCP tools start and control the same persisted workflows as the existing HTTP API", async () => {
  const config = structuredClone(hub.rules);
  config.workflows = {
    document: {
      start: "write",
      roles: { writer: { agent: "a1" } },
      budget: { turns: 2, activeMs: 60_000, concurrency: 1, depth: 0, children: 0 },
      steps: { write: { kind: "agent", role: "writer", prompt: "写文档。", maxAttempts: 1 } },
    },
  };
  config.rules.push({
    name: "MCP 文档",
    when: { source: "app", types: ["document.new"] },
    to: "a1",
    cwd: "/tmp/documents/{item}",
    workflow: "document",
    prompt: "按本次资料写文档。",
    group: "mcp-documents",
    tell: "needed",
  });
  hub.execute("rules", [config]);
  const queued = await tool("workflow_start", { rule: "MCP 文档", subject: "document-1", reason: "写使用说明。" });
  const listed = await tool("workflow_list");
  const item = listed.workflows.find((entry: any) => entry.run === queued.run).id;
  await tool("workflow_pause", { item });
  const paused = await tool("workflow_show", { item });
  const httpPaused = await (await fetch(`${base}/v1/workflows/${item}`, { headers: headers(keys.owner) })).json();
  assert.deepEqual(paused, httpPaused);
  await tool("workflow_resume", { item });
  await tool("workflow_cancel", { item, reason: "撤回目标。" });
  const shown = await tool("workflow_show", { item });
  assert.equal(shown.item.state, "cancelled");
});

test("source MCP events keep the authenticated source and deduplicate on the existing event door", async () => {
  const event = { id: "mcp-http-event", type: "feedback.new", subject: "mcp-http" };
  const first = await tool("emit", event, keys.source);
  assert.equal(first.duplicate, false);
  assert.equal((await tool("emit", event, keys.source)).duplicate, true);
  const spoofed = await post(
    message("tools/call", { name: "emit", arguments: { ...event, source: "ops" } }),
    keys.source,
  );
  assert.equal((await spoofed.json()).error.code, -32602);
  const invalid = await post(message("tools/call", { name: "workflow_show", arguments: { item: 0 } }));
  assert.equal((await invalid.json()).error.code, -32602);
  const missing = await post(message("tools/call", { name: "workflow_show", arguments: { item: 999999 } }));
  assert.equal((await missing.json()).result.isError, true);
});

test("HTTP MCP validates browser origins against the configured address, not the incoming Host", async () => {
  for (const origin of ["https://attacker.test", "null", "not-an-origin"]) {
    assert.equal((await post(message("ping"), keys.owner, { origin })).status, 403);
  }
  assert.equal((await post(message("ping"), keys.owner, { origin: "https://hub.test" })).status, 200);
});

test("HTTP MCP rejects unsupported versions, media types and malformed or oversized messages before dispatch", async () => {
  assert.equal((await post(message("ping"), keys.owner, { "mcp-protocol-version": "2026-07-28" })).status, 400);
  assert.equal((await post(message("ping"), keys.owner, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(message("ping"), keys.owner, { accept: "text/html" })).status, 406);
  const malformed = await fetch(`${base}/mcp`, { method: "POST", headers: headers(keys.owner), body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const batch = await post([message("ping")]);
  assert.equal(batch.status, 400);
  assert.equal((await batch.json()).error.code, -32600);
  assert.equal((await post(message("ping", { text: "x".repeat(1024 * 1024) }))).status, 413);
});
