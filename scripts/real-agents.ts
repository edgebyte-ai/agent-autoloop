// Failure modes: a real CLI never finishes; a receipt is unreadable; the answer loses the session; cleanup leaves a child
// process or a test database. Codex uses its configured model; Claude is pinned to Haiku. All launches share a three-turn ceiling.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus, homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const use = process.argv[2];
assert.ok(["codex", "claude"].includes(use), "用法：node scripts/real-agents.ts codex|claude");
const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
const home = mkdtempSync(join(temporary, `agent-autoloop-real-${use}-`));
let retain = false;
async function main() {
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  mkdirSync(join(home, "work"));
  writeFileSync(
    process.env.AGENT_AUTOLOOP_RULES,
    JSON.stringify({
      sources: { app: { name: "试跑" } },
      agents: {
        real: {
          name: use,
          worker: "test",
          use,
          access: "read",
          timeout: 3,
          ...(use === "claude" ? { model: "claude-haiku-5-5" } : { effort: "low" }),
        },
      },
      channels: {},
      rules: [
        {
          name: "试跑",
          when: { source: "app", types: ["test"] },
          to: "real",
          cwd: join(home, "work"),
          prompt:
            '这是有限的接入测试，只读给出的资料文件，不执行其他动作。answers 为空时，第一行只写“问了一个问题”，附 agent-autoloop 代码块 {"ask":[{"title":"选一个颜色","text":"试跑","options":["蓝色","绿色"],"key":"color"}]}。answers 不为空时，最后一条消息只写“你选了绿色，试跑通过”，不要再提问。',
        },
      ],
    }),
  );
  const { adapterFor } = await import("../worker/agents.ts");
  const adapter = await adapterFor(use);
  if (use === "codex") assert.ok(adapter.open, "普通 use: codex 必须使用常驻适配器");
  let launches = 0;
  let connections = 0;
  if (adapter.open) {
    const open = adapter.open;
    adapter.open = async (options) => {
      connections++;
      const resident = await open(options);
      return {
        ...resident,
        start(turn, checkpoint, persist) {
          if (!checkpoint) assert.ok(++launches <= 3, "已用完三轮额度");
          return resident.start(turn, checkpoint, persist);
        },
      };
    };
  } else {
    const launch = adapter.command;
    adapter.command = (turn) => {
      assert.ok(++launches <= 3, "已用完三轮额度");
      return launch(turn);
    };
  }
  const hub = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const owner = hubClient(url, hub.addKey("owner", "me"));
  const source = hubClient(url, hub.addKey("source", "app"));
  const worker = createWorker({
    hub: hubClient(url, hub.addKey("worker", "test")),
    name: "test",
    wait: 0,
    capacity: 1,
  });
  retain = true;
  const started = Date.now();
  async function until(predicate: (s: any) => boolean) {
    while (Date.now() - started < 240000) {
      await worker.tick();
      const state = await owner.state();
      const failed = state.runs.find((r: any) => r.state === "failed" || r.error);
      if (failed) throw new Error(failed.error ?? JSON.stringify(failed));
      if (predicate(state)) return state;
      await delay(200);
    }
    throw new Error("真机试跑超过四分钟");
  }
  try {
    const problem = adapter.check?.();
    if (problem) throw new Error(problem);
    await source.event({ id: "real", type: "test" });
    const waiting = await until((s) => s.cards.some((c: any) => c.kind === "ask"));
    await owner.answer(waiting.cards[0].id, { choice: 1 });
    const finished = await until((s) =>
      s.runs.some((r: any) => r.state === "done" && r.summary === "你选了绿色，试跑通过"),
    );
    const runs = finished.runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].session, runs[1].session);
    assert.ok(runs[0].session);
    if (use === "codex") assert.equal(connections, 1, "两轮应复用 worker 的常驻连接");
    console.log(
      JSON.stringify(
        {
          machine: cpus()[0].model,
          node: process.version,
          agent: use,
          model: use === "claude" ? "claude-haiku-5-5" : "Codex configured default",
          launches,
          connections,
          runs: runs.length,
          resumed: true,
          ms: Date.now() - started,
          usage: runs.map((r: any) => r.usage),
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      const state = await owner.state();
      for (const entry of worker.entries()) {
        if (state.runs.some((run: any) => run.id === entry.run && ["queued", "claimed"].includes(run.state)))
          await owner.cancel(entry.run);
      }
      const stopBy = Date.now() + 30_000;
      while (worker.entries().length && Date.now() < stopBy) {
        await worker.tick();
        await delay(100);
      }
    } finally {
      try {
        await worker.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        hub.db.close();
      }
    }
    if (worker.entries().length) throw new Error(`未能确认测试运行已结束，保留恢复记录：${home}`);
    retain = false;
  }
}
try {
  await main();
} finally {
  if (retain) console.error(`测试恢复记录尚未清理：${home}`);
  else rmSync(home, { recursive: true, force: true });
}
