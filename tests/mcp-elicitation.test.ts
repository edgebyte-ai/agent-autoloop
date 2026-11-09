// Failure modes: a capable HTTP client cannot receive a card without calling a tool; a source or another owner key takes
// over a session or answers its prompt; a duplicate response records another answer; dismissal loses a question or loops;
// reconnect loses an unanswered card; another answer leaves stale dialogs open; notifications become new questions.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import { setup } from "./helpers.ts";

setup("mcp-elicitation");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const owner = hub.addKey("owner", "elicitation-owner");
const otherOwner = hub.addKey("owner", "other-owner");
const source = hub.addKey("source", "app");
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

type Session = { id: string; key: string; base: string };
const headers = (key: string, session?: string) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
  ...(session && { "mcp-session-id": session }),
});
function post(body: unknown, session?: Session, key = session?.key ?? owner) {
  return fetch(`${session?.base ?? base}/mcp`, {
    method: "POST",
    headers: headers(key, session?.id),
    body: JSON.stringify(body),
  });
}
async function initialize(capabilities: object, key = owner, address = base) {
  return fetch(`${address}/mcp`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "elicitation-test", version: "1" } },
    }),
  });
}
async function client(
  t: TestContext,
  capabilities: object = { elicitation: { form: {} } },
  address = base,
): Promise<Session> {
  const response = await initialize(capabilities, owner, address);
  assert.equal(response.status, 200);
  const id = response.headers.get("mcp-session-id");
  assert.ok(id, "an elicitation-capable owner gets a session");
  const session = { id, key: owner, base: address };
  t.after(async () => {
    await fetch(`${address}/mcp`, { method: "DELETE", headers: headers(owner, id) }).catch(() => {});
  });
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session)).status, 202);
  return session;
}

async function stream(t: TestContext, session: Session) {
  const abort = new AbortController();
  const response = await fetch(`${session.base}/mcp`, {
    headers: { ...headers(session.key, session.id), accept: "text/event-stream" },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const messages: any[] = [];
  let ended = false;
  const reading = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data) messages.push(JSON.parse(data));
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      ended = true;
    }
  })();
  const close = async () => {
    abort.abort();
    await reading;
  };
  t.after(close);
  async function next(matches: (message: any) => boolean) {
    const end = Date.now() + 3_000;
    while (Date.now() < end) {
      const found = messages.find(matches);
      if (found) return found;
      if (ended) assert.fail("the SSE stream ended before the expected message");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`no expected message; received ${JSON.stringify(messages)}`);
  }
  return {
    messages,
    next,
    close,
    reading,
    get ended() {
      return ended;
    },
  };
}

let cards = 0;
function card(t: TestContext, kind: "ask" | "notice" = "ask", fyi = false) {
  const name = `elicitation-${++cards}`;
  const { card: id } = hub.createCard({
    key: name,
    title: name,
    text: "只作为卡片内容显示。",
    kind,
    fyi,
    ...(kind === "ask" && {
      options: ["甲", "乙"],
      source: "app",
      rule: "意见",
      grp: "notes",
      lane: name,
      agent: "a1",
    }),
  });
  t.after(() => {
    if (hub.getView().get("cards", id)?.state === "open") hub.resolve(id, "测试结束。", "本人");
  });
  return { id, title: name };
}
const asks = (title: string) => (message: any) =>
  message.method === "elicitation/create" && message.params.message.includes(title);
const notified = (title: string) => (message: any) =>
  message.method === "notifications/message" && JSON.stringify(message.params).includes(title);
const answer = (request: any, content: object) => ({
  jsonrpc: "2.0",
  id: request.id,
  result: { action: "accept", content },
});

test("only form-capable owner initialization registers a push client; existing clients remain stateless", async (t) => {
  await client(t);
  await client(t, { elicitation: {} });
  for (const [capabilities, key] of [
    [{}, owner],
    [{ elicitation: { url: {} } }, owner],
    [{ elicitation: { form: {} } }, source],
  ] as const) {
    const response = await initialize(capabilities, key);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);
    await response.arrayBuffer();
  }
});

test("cards arrive while the client is idle, and the authenticated original request accepts one answer only", async (t) => {
  const session = await client(t);
  const events = await stream(t, session);
  const question = card(t);
  const request = await events.next(asks(question.title));
  assert.equal(request.params.mode, "form");
  assert.equal(request.params.requestedSchema.type, "object");
  assert.equal(request.params.requestedSchema.properties.choice.type, "string");
  const reply = answer(request, { choice: "1" });
  const stolen = await post(reply, session, otherOwner);
  assert.ok([401, 403, 404].includes(stolen.status));
  assert.equal(hub.getView().get("cards", question.id)!.state, "open");
  const unknown = await post({ ...reply, id: "not-issued-to-this-client" }, session);
  assert.ok([400, 404].includes(unknown.status));
  assert.equal((await post(reply, session)).status, 202);
  const stored = hub.getView().get("cards", question.id)!;
  assert.equal(stored.state, "decided");
  assert.equal(stored.choice, 1);
  assert.ok(stored.answer_event, "the existing answer path wakes the asking matter");
  const acceptedAt = hub.getView().seq;
  assert.equal((await post(reply, session)).status, 202);
  assert.equal(hub.getView().seq, acceptedAt);
});

test("decline and cancel leave questions open without prompting again until the stream reconnects", async (t) => {
  const session = await client(t);
  let events = await stream(t, session);
  for (const action of ["decline", "cancel"]) {
    const question = card(t);
    const request = await events.next(asks(question.title));
    assert.equal((await post({ jsonrpc: "2.0", id: request.id, result: { action } }, session)).status, 202);
    assert.equal(hub.getView().get("cards", question.id)!.state, "open");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.messages.filter(asks(question.title)).length, 1);
    await events.close();
    events = await stream(t, session);
    const replayed = await events.next(asks(question.title));
    assert.equal((await post(answer(replayed, { choice: "free", text: "采用另一种做法。" }), session)).status, 202);
    assert.equal(hub.getView().get("cards", question.id)!.answer, "采用另一种做法。");
  }
});

test("one client's answer cancels the same pending card in other registered clients", async (t) => {
  const first = await client(t);
  const second = await client(t);
  const firstEvents = await stream(t, first);
  const secondEvents = await stream(t, second);
  const question = card(t);
  const firstRequest = await firstEvents.next(asks(question.title));
  const secondRequest = await secondEvents.next(asks(question.title));
  assert.equal((await post(answer(firstRequest, { choice: "0" }), first)).status, 202);
  await secondEvents.next(
    (message) => message.method === "notifications/cancelled" && message.params.requestId === secondRequest.id,
  );
  assert.equal(hub.getView().get("cards", question.id)!.choice, 0);
});

test("ordinary notices accept handling notes, while FYI and settled card updates are noninteractive", async (t) => {
  const session = await client(t);
  const events = await stream(t, session);
  const notice = card(t, "notice");
  const request = await events.next(asks(notice.title));
  assert.equal(request.params.requestedSchema.properties.ack.type, "boolean");
  assert.equal((await post(answer(request, { ack: true, text: "已核对。" }), session)).status, 202);
  assert.equal(hub.getView().get("cards", notice.id)!.state, "closed");
  assert.equal(hub.getView().get("cards", notice.id)!.answer, "已核对。");
  await events.next(notified(notice.title));
  const fyi = card(t, "notice", true);
  await events.next(notified(fyi.title));
  assert.equal(events.messages.filter(asks(fyi.title)).length, 0);
});

test("the original owner answer door settles a pushed card and cancels its outstanding elicitation", async (t) => {
  const session = await client(t);
  const events = await stream(t, session);
  const question = card(t);
  const request = await events.next(asks(question.title));
  const response = await fetch(`${base}/v1/cards/${question.id}/answer`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ choice: 1 }),
  });
  assert.equal(response.status, 200);
  await events.next(
    (message) => message.method === "notifications/cancelled" && message.params.requestId === request.id,
  );
  await events.next(notified(question.title));
});

test("DELETE unregisters the authenticated session, closes its SSE stream and prevents reconnection", async (t) => {
  const session = await client(t);
  const events = await stream(t, session);
  const response = await fetch(`${base}/mcp`, { method: "DELETE", headers: headers(owner, session.id) });
  assert.ok(response.status >= 200 && response.status < 300);
  await events.reading;
  assert.equal(events.ended, true);
  assert.equal(
    (await fetch(`${base}/mcp`, { headers: { ...headers(owner, session.id), accept: "text/event-stream" } })).status,
    404,
  );
});

test("cancelling an SSE reader releases transport state without closing its controller twice", async () => {
  const { createMcpHttp } = await import("../host/mcp.ts");
  const mcp = createMcpHttp(
    async () => Response.json({}),
    (kind, key) => (kind === "owner" && key === owner ? "test" : null),
    "http://local",
    () => ({ cards: [], recentCards: [] }),
  );
  try {
    const initialized = await mcp.handle(
      new Request("http://local/mcp", {
        method: "POST",
        headers: headers(owner),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { capabilities: { elicitation: { form: {} } } },
        }),
      }),
    );
    const id = initialized.headers.get("mcp-session-id")!;
    const response = await mcp.handle(
      new Request("http://local/mcp", {
        headers: { ...headers(owner, id), accept: "text/event-stream" },
      }),
    );
    await response.body!.cancel();
  } finally {
    mcp.close();
  }
});
