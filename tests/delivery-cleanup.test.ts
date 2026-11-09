// Failure modes: Windows cleanup replaces the actual delivery error, or turns a finished operation into a retry.
// No remote calls run: the CLI and a persistently locked scratch directory are substituted at their native boundaries.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../plugins/delivery/run.ts";

test("a cleanup failure preserves both failed and successful delivery outcomes and names the retained directory", async (t) => {
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  if (process.platform === "win32") process.env.TEMP = process.env.TMP = join(homedir(), "AppData", "Local", "Temp");
  const realRemove = fs.rmSync;
  const retained: string[] = [];
  const messages: string[] = [];
  const original = new Error("真实 Git 请求超时");
  let fail = true;
  t.mock.method(childProcess, "execFileSync", (file: unknown) => {
    assert.equal(file, "gh");
    if (fail) throw original;
    return JSON.stringify({ state: "closed", labels: [] });
  });
  t.mock.method(fs, "rmSync", (folder: fs.PathLike) => {
    retained.push(String(folder));
    throw Object.assign(new Error("directory still locked"), { code: "EPERM" });
  });
  t.mock.method(console, "error", (line: string) => messages.push(line));
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      run("example/test", { events: [{ subject: "example/test#1" }] }),
      (error) => error === original,
    );
    fail = false;
    assert.equal(await run("example/test", { events: [{ subject: "example/test#2" }] }), "没事可做：没有待处理的问题");
    assert.equal(messages.length, 2);
    for (const [index, folder] of retained.entries()) {
      assert.ok(fs.existsSync(folder));
      assert.ok(messages[index].includes(folder), "the complete cleanup path must remain available");
      assert.match(messages[index], /directory still locked/);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const folder of retained) realRemove(folder, { recursive: true, force: true });
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  }
});
