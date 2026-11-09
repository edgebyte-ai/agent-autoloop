// Failure mode: the API uses the signed-in CLI but a private Git fetch waits on a different credential manager.
// Fetch credentials must stay command-local, never become a token in the remote URL or a user-global Git setting.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createIO } from "../plugins/delivery/github.ts";
import { settings } from "../plugins/delivery/project.ts";

test("private object fetch uses gh credentials without changing global Git configuration", async (t) => {
  const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
  const root = mkdtempSync(join(temporary, "autoloop-delivery-fetch-"));
  const seen: string[][] = [];
  const fetched = new Error("fetch reached");
  const mock = t.mock.method(childProcess, "execFileSync", (program: string, args: string[]) => {
    assert.equal(program, "git");
    seen.push(args);
    assert.ok(!args.includes("--global"));
    if (args.includes("fetch")) {
      assert.ok(args.includes("credential.helper="), "clear unrelated credential helpers for this command");
      assert.ok(args.includes("credential.helper=!gh auth git-credential"), "use the same login as the GitHub API");
      throw fetched;
    }
    return "";
  });
  syncBuiltinESMExports();
  try {
    const io = createIO("owner/private", root);
    await assert.rejects(
      io.review(
        { head: { sha: "b".repeat(40) } },
        settings({ repo: "owner/private", internal: [], review: { points: "AGENTS.md" } }),
        "a".repeat(40),
      ),
      (error) => error === fetched,
    );
    const remote = seen.find((args) => args.includes("remote"))!;
    assert.equal(remote.at(-1), "https://github.com/owner/private.git");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
