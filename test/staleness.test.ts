import { describe, expect, test, beforeEach, afterEach, setSystemTime } from "bun:test";

import {
  assertSaneChainAgeSeconds,
  computeStalenessBound,
  describeStalenessBound,
  getStalenessBound,
  refreshStalenessBound,
  resetStalenessBoundCache,
  setMaxSourceDateAgeReader,
  type StalenessBound,
} from "../src/staleness.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { toScaledPrice, StalePriceError } from "../src/price-source.js";

const HOUR = 3_600_000;

// The live value on the deployed diamond, verified with
//   cast call 0xEd6eDf5C44fDD21a4D1073fCcF4eC3C22525BE62 "MAX_SOURCE_DATE_AGE()(uint256)"
// which returns 259200 (72h).
const CHAIN_72H_SECONDS = 259_200n;

// The outage this change was written for: MOC published nothing over the
// 2026-07-28..2026-07-31 holiday cluster, so the newest row is dated 07-27.
// Pinned "now" puts that price at exactly 100h old, matching the production log.
const NOW = new Date("2026-07-31T04:00:00Z");
const PRICE_DATE_2026_07_27 = "2026-07-27T00:00:00Z";

function quote(date: string) {
  return { productCode: "P14001", priceMin: 12.5, priceMax: 13.1, date };
}

function setBaseEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    REPORTER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "31337",
    NETWORK: "local",
    ORACLE_ADDRESS: "0xEd6eDf5C44fDD21a4D1073fCcF4eC3C22525BE62",
    STALE_PRICE_HOURS: undefined,
    STALENESS_BOUND_TTL_MS: undefined,
    POLL_INTERVAL_MS: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  resetStalenessBoundCache();
}

describe("computeStalenessBound", () => {
  test("the on-chain value governs when STALE_PRICE_HOURS is left at its default", () => {
    const bound = computeStalenessBound({
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(72 * HOUR);
    expect(bound.source).toBe("chain");
    expect(bound.clamped).toBe(false);
  });

  test("an explicit STALE_PRICE_HOURS tightens below the chain", () => {
    const bound = computeStalenessBound({
      localMs: 24 * HOUR,
      localExplicit: true,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(24 * HOUR);
    expect(bound.source).toBe("local-override");
    expect(bound.clamped).toBe(false);
  });

  test("an explicit STALE_PRICE_HOURS cannot loosen past the chain - it is clamped", () => {
    const bound = computeStalenessBound({
      localMs: 240 * HOUR,
      localExplicit: true,
      chainMs: 72 * HOUR,
    });

    expect(bound.effectiveMs).toBe(72 * HOUR);
    expect(bound.source).toBe("chain");
    expect(bound.clamped).toBe(true);
    // The whole point: a looser local value must not turn a free local skip into
    // a paid on-chain revert.
    expect(bound.effectiveMs).toBeLessThan(bound.localMs);
  });

  test("a failed chain read falls back to the configured local value", () => {
    const bound = computeStalenessBound({
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: null,
      chainError: "HTTP request failed",
    });

    expect(bound.effectiveMs).toBe(48 * HOUR);
    expect(bound.source).toBe("local-fallback");
    expect(bound.chainError).toBe("HTTP request failed");
  });

  test("the description names both bounds and which one won", () => {
    const chainWins = describeStalenessBound(
      computeStalenessBound({ localMs: 48 * HOUR, localExplicit: false, chainMs: 72 * HOUR }),
    );
    expect(chainWins).toContain("MAX_SOURCE_DATE_AGE=72h");
    expect(chainWins).toContain("STALE_PRICE_HOURS=48h");
    expect(chainWins).toContain("bound=72h");

    const readFailed = describeStalenessBound(
      computeStalenessBound({
        localMs: 48 * HOUR,
        localExplicit: false,
        chainMs: null,
        chainError: "boom",
      }),
    );
    expect(readFailed).toContain("MAX_SOURCE_DATE_AGE=unavailable");
    expect(readFailed).toContain("boom");
  });
});

describe("assertSaneChainAgeSeconds", () => {
  test("accepts the live on-chain value", () => {
    expect(assertSaneChainAgeSeconds(CHAIN_72H_SECONDS)).toBe(CHAIN_72H_SECONDS);
  });

  test("rejects zero and absurd values rather than obeying them", () => {
    expect(() => assertSaneChainAgeSeconds(0n)).toThrow(/outside the sane range/);
    expect(() => assertSaneChainAgeSeconds(400n * 24n * 3600n)).toThrow(/outside the sane range/);
    expect(() => assertSaneChainAgeSeconds(259_200)).toThrow(/expected a uint256/);
  });
});

describe("getStalenessBound", () => {
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
    setMaxSourceDateAgeReader(null);
  });

  test("honours the value read off the chain", async () => {
    setBaseEnv();
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(bound.chainMs).toBe(72 * HOUR);
    expect(bound.effectiveMs).toBe(72 * HOUR);
    expect(bound.source).toBe("chain");
  });

  test("a local override tightens the chain value", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "24" });
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(loadConfig().staleThresholdExplicit).toBe(true);
    expect(bound.effectiveMs).toBe(24 * HOUR);
    expect(bound.source).toBe("local-override");
  });

  test("a local override looser than the chain is clamped back", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "240" });
    setMaxSourceDateAgeReader(async () => CHAIN_72H_SECONDS);

    const bound = await getStalenessBound();

    expect(bound.effectiveMs).toBe(72 * HOUR);
    expect(bound.clamped).toBe(true);
  });

  test("a failed chain read falls back to the configured value and logs the failure", async () => {
    setBaseEnv();
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    setMaxSourceDateAgeReader(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
    });

    const bound = await getStalenessBound();

    expect(bound.effectiveMs).toBe(48 * HOUR);
    expect(bound.source).toBe("local-fallback");
    // A bad RPC has to look like a bad RPC, not like a stale price.
    expect(logged.join("\n")).toContain("ECONNREFUSED");
    expect(logged.join("\n")).toContain("MAX_SOURCE_DATE_AGE");
    expect(logged.join("\n")).toContain("not a stale price");
  });

  test("the chain value is re-read, never cached for the process lifetime", async () => {
    setBaseEnv({ STALENESS_BOUND_TTL_MS: "60000" });
    let reads = 0;
    let onChain = CHAIN_72H_SECONDS;
    setMaxSourceDateAgeReader(async () => {
      reads += 1;
      return onChain;
    });

    expect((await getStalenessBound()).effectiveMs).toBe(72 * HOUR);
    // Within the TTL, a second caller reuses the read rather than doing one
    // eth_call per market.
    expect((await getStalenessBound()).effectiveMs).toBe(72 * HOUR);
    expect(reads).toBe(1);

    // An operator widens the limit to end an outage. No restart.
    onChain = 10n * 24n * 3600n;
    expect((await refreshStalenessBound()).effectiveMs).toBe(240 * HOUR);
    expect(reads).toBe(2);
  });
});

describe("the 2026-07-27 price, before and after", () => {
  beforeEach(() => {
    setSystemTime(NOW);
  });

  afterEach(() => {
    setSystemTime();
  });

  test("the price really is 100h old at the pinned time", () => {
    const ageMs = Date.now() - new Date(PRICE_DATE_2026_07_27).getTime();
    expect(ageMs / HOUR).toBe(100);
  });

  test("old behaviour: a bare 48h local bound skips it, naming only STALE_PRICE_HOURS", () => {
    // What the node did before this change - the local 48h was the whole story.
    const oldBound: StalenessBound = {
      effectiveMs: 48 * HOUR,
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: null,
      source: "local-fallback",
      clamped: false,
    };

    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), oldBound)).toThrow(StalePriceError);
  });

  test("new behaviour: still skipped at 72h, but the message names the chain bound", () => {
    const bound = computeStalenessBound({
      localMs: 48 * HOUR,
      localExplicit: false,
      chainMs: 72 * HOUR,
    });

    let message = "";
    try {
      toScaledPrice(quote(PRICE_DATE_2026_07_27), bound);
      throw new Error("expected a StalePriceError");
    } catch (err) {
      expect(err).toBeInstanceOf(StalePriceError);
      message = (err as Error).message;
    }

    expect(message).toContain("100h old");
    expect(message).toContain("effective staleness bound of 72h");
    expect(message).toContain("MAX_SOURCE_DATE_AGE=72h");
    expect(message).toContain("STALE_PRICE_HOURS=48h (default)");
  });

  test("widening the on-chain limit to 10 days flips the same price to accepted", async () => {
    setBaseEnv();
    setMaxSourceDateAgeReader(async () => 10n * 24n * 3600n);
    const bound = await getStalenessBound();
    setMaxSourceDateAgeReader(null);

    expect(bound.effectiveMs).toBe(240 * HOUR);

    const scaled = toScaledPrice(quote(PRICE_DATE_2026_07_27), bound);

    expect(scaled.priceMin).toBe(12_500_000n);
    expect(scaled.priceMax).toBe(13_100_000n);
    expect(scaled.sourceDate).toBe(BigInt(new Date(PRICE_DATE_2026_07_27).getTime() / 1000));
  });

  test("a 48h local override still tightens, so the operator keeps the stricter policy", async () => {
    setBaseEnv({ STALE_PRICE_HOURS: "48" });
    setMaxSourceDateAgeReader(async () => 10n * 24n * 3600n);
    const bound = await getStalenessBound();
    setMaxSourceDateAgeReader(null);

    expect(bound.effectiveMs).toBe(48 * HOUR);
    expect(() => toScaledPrice(quote(PRICE_DATE_2026_07_27), bound)).toThrow(StalePriceError);
  });
});
