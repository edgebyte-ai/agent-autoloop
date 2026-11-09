// Failure modes: each turn launches another server or resumes an already loaded thread; parallel threads mix results,
// directories or privileges; interrupting one turn kills another; a lost start reply repeats completed work; and a
// lost thread creation reply silently creates another thread instead of recording an unresolved execution. Interactive
// input consumes more model work while waiting, an old transport error poisons a recovered answer, or idle threads stay loaded.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import codex from "../plugins/codex/agent.ts";
import type { Adapter, Checkpoint, Resident, Turn } from "../worker/agents.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

async function fixture(t: TestContext, environment: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-resident-"));
  const program = join(home, process.platform === "win32" ? "codex.cmd" : "codex");
  copyFileSync(join(import.meta.dirname, "fixtures", "codex-server.mjs"), join(home, "server.mjs"));
  writeFileSync(
    program,
    process.platform === "win32"
      ? '@echo off\r\nnode "%~dp0\\server.mjs" %*\r\n'
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(home, "server.mjs").replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  const logFile = join(home, "rpc.jsonl");
  const residents: Resident[] = [];
  t.after(async () => {
    for (const resident of residents) await resident.close();
    rmSync(home, { recursive: true, force: true });
  });
  async function open(overrides: NodeJS.ProcessEnv = {}) {
    const create = (codex as Adapter).open;
    assert.equal(typeof create, "function", "Codex must expose a worker-owned resident adapter");
    const resident = await create!({
      folder: home,
      log: () => {},
      environment: {
        ...process.env,
        FAKE_CODEX_STATE: join(home, "history.json"),
        FAKE_CODEX_LOG: logFile,
        ...environment,
        ...overrides,
      },
    });
    residents.push(resident);
    return resident;
  }
  const messages = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  function turn(name: string, extra: Partial<Turn> = {}): Turn {
    const folder = join(home, name);
    mkdirSync(folder, { recursive: true });
    return {
      prompt: `TEST:${name}`,
      session: `new-${name}`,
      resume: null,
      cwd: folder,
      access: "read",
      program,
      contextFile: "",
      folder,
      ...extra,
    };
  }
  return { open, messages, turn };
}

function recording() {
  let value: Checkpoint | undefined;
  return {
    get value() {
      return value;
    },
    persist(checkpoint: Checkpoint) {
      value = JSON.parse(JSON.stringify(checkpoint));
    },
  };
}

async function until(ready: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "the protocol peer did not reach the expected state");
    await delay(10);
  }
}

test(
  "Codex shares one server, isolates concurrent threads, and directly continues a loaded role",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const resident = await f.open();
    const developer = recording();
    const reviewer = recording();
    const [first, review] = await Promise.all([
      resident.start(
        f.turn("developer", { model: "dev-model", effort: "high", access: "edit" }),
        undefined,
        developer.persist,
      ),
      resident.start(
        f.turn("reviewer", { model: "review-model", effort: "low", access: "read" }),
        undefined,
        reviewer.persist,
      ),
    ]);
    assert.equal(first.text, "完成:developer");
    assert.equal(review.text, "完成:reviewer");
    assert.notEqual(first.session, review.session);
    const fixed = await resident.start(
      f.turn("developer", {
        prompt: "TEST:fix",
        resume: first.session!,
        model: "dev-model",
        effort: "high",
        access: "edit",
      }),
      undefined,
      recording().persist,
    );
    assert.equal(fixed.session, first.session);
    assert.equal(fixed.text, "完成:fix");
    const messages = f.messages();
    assert.equal(messages.filter((message) => message.method === "process").length, 1);
    assert.equal(messages.filter((message) => message.method === "thread/start").length, 2);
    assert.equal(messages.filter((message) => message.method === "thread/resume").length, 0);
    assert.ok(messages.find((message) => message.method === "process").argv.includes("app-server"));
    const starts = messages.filter((message) => message.method === "turn/start");
    assert.equal(starts.length, 3);
    const devStart = starts.find((message) =>
      message.params.input.some((input: { text?: string }) => input.text?.includes("TEST:developer")),
    );
    const reviewStart = starts.find((message) =>
      message.params.input.some((input: { text?: string }) => input.text?.includes("TEST:reviewer")),
    );
    assert.equal(devStart.params.cwd, f.turn("developer").cwd);
    assert.equal(reviewStart.params.cwd, f.turn("reviewer").cwd);
    assert.equal(devStart.params.model, "dev-model");
    assert.equal(reviewStart.params.model, "review-model");
    assert.equal(devStart.params.effort, "high");
    assert.equal(reviewStart.params.effort, "low");
    assert.equal(devStart.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(reviewStart.params.sandboxPolicy.type, "readOnly");
    assert.ok(
      !messages.some((message) => message.params?.modelProvider),
      "the user's provider remains configured by their CLI",
    );
  },
);

test("Codex interrupts only the addressed turn while another thread finishes", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const stopping = recording();
  const other = recording();
  const first = resident.start(f.turn("stop", { prompt: "TEST:stop HOLD" }), undefined, stopping.persist);
  const second = resident.start(f.turn("other", { prompt: "TEST:other SLOW" }), undefined, other.persist);
  await until(() => f.messages().filter((message) => message.method === "turn/start").length === 2);
  await until(() => JSON.stringify(stopping.value).includes("turn-"));
  await resident.interrupt(stopping.value!);
  const stopped = await first;
  assert.ok(stopped.finished);
  assert.ok(stopped.error, "an interrupted turn is not a completed answer");
  assert.equal(stopped.usage, undefined, "missing usage stays unknown");
  const interrupts = f.messages().filter((message) => message.method === "turn/interrupt");
  assert.equal(interrupts.length, 1);
  const completed = await second;
  assert.equal(completed.text, "完成:other");
  assert.notEqual(interrupts[0].params.threadId, completed.session);
  const next = await resident.start(f.turn("after"), undefined, recording().persist);
  assert.equal(next.text, "完成:after");
  assert.equal(f.messages().filter((message) => message.method === "process").length, 1);
});

test("Codex replays a saved completed result after its owner restarts", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const saved = recording();
  const turn = f.turn("completed");
  const first = await resident.start(turn, undefined, saved.persist);
  await resident.close();
  const restarted = await f.open();
  const replay = await restarted.start(turn, saved.value, saved.persist);
  assert.equal(replay.text, first.text);
  assert.equal(replay.session, first.session);
  assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
});

test("Codex serializes turns that share a role thread", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const first = await resident.start(f.turn("role"), undefined, recording().persist);
  const [fix, again] = await Promise.all([
    resident.start(f.turn("role", { resume: first.session!, prompt: "TEST:fix SLOW" }), undefined, recording().persist),
    resident.start(f.turn("role", { resume: first.session!, prompt: "TEST:again" }), undefined, recording().persist),
  ]);
  assert.equal(fix.text, "完成:fix");
  assert.equal(again.text, "完成:again");
  assert.equal(fix.session, first.session);
  assert.equal(again.session, first.session);
  assert.equal(f.messages().filter((message) => message.method === "thread/start").length, 1);
  assert.equal(f.messages().filter((message) => message.method === "thread/resume").length, 0);
});

test(
  "Codex recovers a completed turn whose start reply was lost without repeating it",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.open();
    const saved = recording();
    const turn = f.turn("lost", { prompt: "TEST:lost LOSE_REPLY" });
    await first.start(turn, undefined, saved.persist);
    await first.close();
    const recovered = await f.open();
    const result = await recovered.start(turn, saved.value, saved.persist);
    assert.equal(result.text, "完成:lost");
    assert.ok(result.finished);
    assert.equal(result.blocked, undefined);
    assert.equal(result.error, undefined, "a recovered successful result cannot retain the old transport error");
    assert.equal(result.activeMs, 100, "recovery keeps actual activity instead of counting offline time");
    assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
    assert.ok(f.messages().some((message) => message.method === "thread/read"));
  },
);

test("Codex does not silently create another thread after an uncertain creation", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { FAKE_CODEX_LOSE_THREAD: "1" });
  const resident = await f.open();
  const saved = recording();
  const turn = f.turn("unknown");
  const initial = await resident.start(turn, undefined, saved.persist);
  assert.equal(initial.blocked, true);
  await resident.close();
  const restarted = await f.open();
  const result = await restarted.start(turn, saved.value, saved.persist);
  assert.equal(result.blocked, true);
  assert.equal(f.messages().filter((message) => message.method === "thread/start").length, 1);
  assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 0);
});

test(
  "Codex rejects a different program in the same worker without using the first program",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const resident = await f.open();
    await resident.start(f.turn("first"), undefined, recording().persist);
    const different = f.turn("different");
    different.program = `${different.program}.other`;
    const result = await resident.start(different, undefined, recording().persist);
    assert.match(result.error ?? "", /program/);
    assert.equal(result.text, undefined);
    assert.equal(f.messages().filter((message) => message.method === "process").length, 1);
    assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
  },
);

test("Codex unloads an idle thread and resumes it for the next turn", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const first = await resident.start(f.turn("idle", { threadIdleMinutes: 0.001 }), undefined, recording().persist);
  await until(() => f.messages().some((message) => message.method === "thread/unsubscribe"));
  const next = await resident.start(
    f.turn("idle", { resume: first.session!, prompt: "TEST:awakened" }),
    undefined,
    recording().persist,
  );
  assert.equal(next.text, "完成:awakened");
  assert.equal(next.session, first.session);
  assert.equal(f.messages().filter((message) => message.method === "process").length, 1);
  assert.equal(f.messages().filter((message) => message.method === "thread/resume").length, 1);
});

test("Codex turns interactive input into a card and releases only that turn", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const [asked, other] = await Promise.all([
    resident.start(f.turn("question", { prompt: "TEST:question ASK_INPUT" }), undefined, recording().persist),
    resident.start(f.turn("unrelated", { prompt: "TEST:unrelated SLOW" }), undefined, recording().persist),
  ]);
  assert.ok(asked.finished);
  assert.equal(asked.error, undefined, "waiting for a person is not a failed turn that the hub retries");
  const receipt = resultFrom(readMessage(asked.text ?? ""), { session: asked.session });
  assert.equal(receipt.problem, undefined);
  assert.equal(receipt.result.ask?.length, 1);
  assert.match(receipt.result.ask![0].text, /是否继续处理这份资料/);
  assert.deepEqual(receipt.result.ask![0].options, ["继续", "停止"]);
  assert.equal(other.text, "完成:unrelated");
  const messages = f.messages();
  const interrupts = messages.filter((message) => message.method === "turn/interrupt");
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].params.threadId, asked.session);
  assert.notEqual(interrupts[0].params.threadId, other.session);
  assert.equal(messages.filter((message) => message.method === "turn/start").length, 2);
  assert.ok(
    !messages.some(
      (message) => message.id?.toString().startsWith("question-") && Object.keys(message.result?.answers ?? {}).length,
    ),
    "the client does not invent an answer and continue model work",
  );
  const continued = await resident.start(
    f.turn("question", { resume: asked.session!, prompt: "TEST:answered" }),
    undefined,
    recording().persist,
  );
  assert.equal(continued.session, asked.session);
  assert.equal(continued.text, "完成:answered");
});

test("Codex accepts cancellation before a turn exists without launching model work", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { FAKE_CODEX_INIT_DELAY_MS: "200" });
  const resident = await f.open();
  const saved = recording();
  const pending = resident.start(f.turn("cancel-start"), undefined, saved.persist);
  await until(() => Boolean(saved.value?.requestId));
  await resident.interrupt(saved.value!);
  const cancelled = await pending;
  assert.ok(cancelled.finished, "the cancellation is acknowledged after startup has stopped");
  assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 0);
  assert.match(cancelled.error ?? "", /中断|停止|取消/);
  const next = await resident.start(f.turn("after-cancel"), undefined, recording().persist);
  assert.equal(next.text, "完成:after-cancel");
  assert.equal(f.messages().filter((message) => message.method === "process").length, 1);
});

test("Codex preserves a free-text input request as a valid question card", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const asked = await resident.start(
    f.turn("free-text", { prompt: "TEST:free-text ASK_INPUT ASK_TEXT" }),
    undefined,
    recording().persist,
  );
  assert.equal(asked.error, undefined);
  const receipt = resultFrom(readMessage(asked.text ?? ""), { session: asked.session });
  assert.equal(receipt.problem, undefined, "the hub must accept the converted request without a repair turn");
  assert.equal(receipt.result.ask?.length, 1);
  assert.match(receipt.result.ask![0].text, /是否继续处理这份资料/);
  assert.ok(receipt.result.ask![0].options.length >= 2);
  assert.ok(receipt.result.ask![0].options.length <= 5);
  assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
});

test(
  "Codex gives different questions distinct keys even when the operation id is a long path",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const resident = await f.open();
    const asked = await resident.start(
      f.turn("two-questions", {
        id: "C:\\Users\\archi\\AppData\\Local\\agent-autoloop\\workflow\\" + "工作项目录".repeat(45) + "\\1",
        prompt: "TEST:two-questions ASK_INPUT ASK_TWO",
      }),
      undefined,
      recording().persist,
    );
    const receipt = resultFrom(readMessage(asked.text ?? ""), { session: asked.session });
    assert.equal(receipt.problem, undefined);
    assert.equal(receipt.result.ask?.length, 2);
    assert.equal(new Set(receipt.result.ask!.map((question) => question.key)).size, 2);
  },
);

test("Codex exposes the actual turn id in its persisted and returned reading", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const resident = await f.open();
  const saved = recording();
  const result = await resident.start(f.turn("identified"), undefined, saved.persist);
  assert.match(String(saved.value?.turnId), /^turn-/);
  assert.equal(saved.value?.reading?.turn, saved.value?.turnId);
  assert.equal(result.turn, saved.value?.turnId);
});

test(
  "Codex declines a permissions request with its protocol response and asks for handling",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const resident = await f.open();
    const result = await resident.start(
      f.turn("permissions", { prompt: "TEST:permissions ASK_PERMISSION" }),
      undefined,
      recording().persist,
    );
    await until(() => f.messages().some((message) => message.id?.toString().startsWith("permission-")));
    const response = f.messages().find((message) => message.id?.toString().startsWith("permission-"));
    assert.deepEqual(response.result, { permissions: {}, scope: "turn" });
    assert.ok(result.finished);
    assert.equal(result.error, undefined);
    const receipt = resultFrom(readMessage(result.text ?? ""), { session: result.session });
    assert.equal(receipt.problem, undefined);
    assert.equal(receipt.result.ask?.length, 1);
    assert.equal(f.messages().filter((message) => message.method === "turn/interrupt").length, 1);
    assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
  },
);

test(
  "Codex keeps cumulative usage across model requests and repeated usage notifications",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const resident = await f.open();
    const first = await resident.start(f.turn("usage"), undefined, recording().persist);
    assert.deepEqual(first.sessionUsage, { input: 17, output: 5, cached: 5 });
    assert.equal(first.usage, undefined);
    const next = await resident.start(
      f.turn("usage", { resume: first.session!, prompt: "TEST:more-usage" }),
      undefined,
      recording().persist,
    );
    assert.deepEqual(next.sessionUsage, { input: 34, output: 10, cached: 10 });
    assert.equal(next.usage, undefined);
  },
);

test("Codex cancels a recovered active turn even when its start reply was lost", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { FAKE_CODEX_INIT_DELAY_MS: "200", FAKE_CODEX_LOSE_INTERRUPT: "1" });
  const resident = await f.open();
  const saved = recording();
  const turn = f.turn("recover-cancel", { prompt: "TEST:recover-cancel HOLD" });
  const pending = resident.start(turn, undefined, saved.persist);
  await until(() => Boolean(saved.value?.turnId));
  const originalTurn = saved.value!.turnId;
  const originalThread = saved.value!.threadId;
  await resident.close();
  assert.ok((await pending).blocked);
  const uncertain: Checkpoint = { ...saved.value!, phase: "starting", reading: { ...saved.value!.reading } };
  delete uncertain.turnId;
  delete uncertain.reading!.turn;
  const restarted = await f.open({ FAKE_CODEX_LOSE_INTERRUPT: "0" });
  const recovering = recording();
  const recovered = restarted.start(turn, uncertain, recovering.persist);
  await until(() => Boolean(recovering.value?.requestId));
  assert.equal(recovering.value!.turnId, undefined);
  await restarted.interrupt(recovering.value!);
  const result = await recovered;
  assert.ok(result.finished);
  assert.match(result.error ?? "", /中断|停止|取消/);
  const interrupts = f.messages().filter((message) => message.method === "turn/interrupt");
  assert.equal(interrupts.length, 2);
  assert.equal(interrupts[1].params.threadId, originalThread);
  assert.equal(interrupts[1].params.turnId, originalTurn);
  assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
});

test(
  "Codex marks recovered usage unknown when only a partial total arrived before disconnection",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.open();
    const snapshots: Checkpoint[] = [];
    const turn = f.turn("partial", { prompt: "TEST:partial PARTIAL_LOST" });
    const result = await first.start(turn, undefined, (checkpoint) => snapshots.push(structuredClone(checkpoint)));
    assert.ok(snapshots.some((checkpoint) => checkpoint.reading?.sessionUsage?.input === 10));
    assert.equal(result.text, "完成:partial");
    assert.ok(result.finished);
    assert.deepEqual(
      result.sessionUsage,
      {},
      "the partial total is not the final turn's usage or a valid later baseline",
    );
    assert.equal(result.usage, undefined);
    assert.equal(f.messages().filter((message) => message.method === "turn/start").length, 1);
  },
);
