import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

// Runs each test/loop/*.loop.ts spec in a fresh `bun test` process. The specs
// replace config/oracle/markets with mock.module, stub process.exit and send
// SIGTERM to the process, none of which may leak into the other test files.
const LOOP_DIR = new URL("./loop/", import.meta.url).pathname;
const specs = readdirSync(LOOP_DIR).filter((f) => f.endsWith(".loop.ts"));

describe("reporter loop", () => {
  test("found the loop specs", () => {
    expect(specs.length).toBeGreaterThanOrEqual(5);
  });
  for (const spec of specs) {
    test(spec, () => {
      const run = Bun.spawnSync([process.execPath, "test", LOOP_DIR + spec], { stdout: "pipe", stderr: "pipe" });
      const out = run.stdout.toString() + run.stderr.toString();
      if (run.exitCode !== 0) console.error(out);
      expect(run.exitCode).toBe(0);
      expect(out).toContain(" 0 fail");
    }, 20_000);
  }
});
