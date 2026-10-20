import { beforeEach, describe, expect, test } from "bun:test";

import {
  createPriceCache,
  forEachIsolated,
  isTerminal,
  markTerminal,
  resetTerminalQuestions,
  terminalRevertName,
} from "../src/cycle-state.js";

describe("forEachIsolated", () => {
  test("a market that throws does not stop the later ones", async () => {
    const seen: number[] = [];
    const errors: number[] = [];
    await forEachIsolated(
      [1, 2, 3],
      async (n) => {
        if (n === 1) throw new Error("unknown revert");
        seen.push(n);
      },
      (n) => errors.push(n),
    );
    expect(seen).toEqual([2, 3]);
    expect(errors).toEqual([1]);
  });

  test("rethrows the first error when every market failed", async () => {
    await expect(
      forEachIsolated(
        [1, 2],
        async (n) => {
          throw new Error(`boom ${n}`);
        },
        () => {},
      ),
    ).rejects.toThrow("boom 1");
  });

  test("an empty list is not a failure", async () => {
    await forEachIsolated([], async () => {}, () => {});
  });
});

describe("terminal questions", () => {
  beforeEach(() => resetTerminalQuestions());

  test("marks once, case-insensitively", () => {
    expect(isTerminal("0xAB")).toBe(false);
    expect(markTerminal("0xAB")).toBe(true);
    expect(markTerminal("0xab")).toBe(false);
    expect(isTerminal("0xAB")).toBe(true);
  });

  test("decoded name wins, message is the fallback", () => {
    expect(terminalRevertName("ReportingAlreadyFailed", "")).toBe("ReportingAlreadyFailed");
    expect(terminalRevertName("SourceDateTooOld", "ReportingWindowClosed")).toBeUndefined();
    expect(terminalRevertName(undefined, "execution reverted: Reporting window closed")).toBe("Reporting window closed");
    expect(terminalRevertName(undefined, "Already reported")).toBeUndefined();
  });
});

describe("createPriceCache", () => {
  test("fetches once per product, including concurrent callers", async () => {
    const calls: string[] = [];
    const get = createPriceCache(async (code: string) => {
      calls.push(code);
      return code.length;
    });
    const results = await Promise.all([get("RICE"), get("RICE"), get("CORN")]);
    await get("RICE");
    expect(results).toEqual([4, 4, 4]);
    expect(calls).toEqual(["RICE", "CORN"]);
  });

  test("a failure is shared within the cycle, a new cache retries", async () => {
    let n = 0;
    const fetcher = async () => {
      n++;
      throw new Error("scrape failed");
    };
    const first = createPriceCache(fetcher);
    await expect(first("RICE")).rejects.toThrow();
    await expect(first("RICE")).rejects.toThrow();
    expect(n).toBe(1);
    await expect(createPriceCache(fetcher)("RICE")).rejects.toThrow();
    expect(n).toBe(2);
  });
});
