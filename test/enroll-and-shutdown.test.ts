import { describe, expect, mock, test } from "bun:test";

import { ensureEnrolled } from "../src/reporter.js";
import { hasPendingTx, waitForDrain } from "../src/shutdown.js";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const COOLDOWN = 5 * 60 * 1000;

type Opts = { registered: boolean; stake: bigint; balance: bigint; pending?: number; latest?: number };

function fakeClients(o: Opts) {
  const writes: string[] = [];
  const clients = {
    account: { address: ME },
    config: { autoEnroll: true, autoEnrollStake: undefined, oracleAddress: "0x0000000000000000000000000000000000000001" },
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getReporterInfo") return [o.registered, o.stake, 0n, 0n, 0n];
        if (functionName === "MIN_STAKE") return 1_000n;
        if (functionName === "ACTIVE_THRESHOLD") return 500n;
        if (functionName === "REGISTRATION_FEE") return 10n;
        throw new Error(functionName);
      },
      getBalance: async () => o.balance,
      getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
        blockTag === "pending" ? (o.pending ?? 0) : (o.latest ?? 0),
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
    walletClient: {
      chain: undefined,
      writeContract: async ({ functionName }: { functionName: string }) => {
        writes.push(functionName);
        return "0xhash";
      },
    },
  };
  return { clients: clients as never, writes };
}

const ETH = 10n ** 18n;
let clock = 0;
const nextNow = () => (clock += 10 * COOLDOWN);

describe("ensureEnrolled", () => {
  test("does not exit the process when the wallet is underfunded", async () => {
    const exit = mock(() => undefined as never);
    const real = process.exit;
    process.exit = exit as never;
    try {
      const { clients, writes } = fakeClients({ registered: false, stake: 0n, balance: 0n });
      await ensureEnrolled(clients, nextNow());
      expect(exit).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    } finally {
      process.exit = real;
    }
  });

  test("registers a funded, unregistered node", async () => {
    const { clients, writes } = fakeClients({ registered: false, stake: 0n, balance: 5n * ETH });
    await ensureEnrolled(clients, nextNow());
    expect(writes).toEqual(["registerReporter"]);
  });

  test("an active node sends nothing", async () => {
    const { clients, writes } = fakeClients({ registered: true, stake: 900n, balance: 5n * ETH });
    await ensureEnrolled(clients, nextNow());
    expect(writes).toEqual([]);
  });

  test("a slashed node (below threshold) is topped up", async () => {
    const { clients, writes } = fakeClients({ registered: true, stake: 100n, balance: 5n * ETH });
    await ensureEnrolled(clients, nextNow());
    expect(writes).toEqual(["addStake"]);
  });

  test("skips when a tx is pending (pending nonce > latest)", async () => {
    const { clients, writes } = fakeClients({ registered: true, stake: 100n, balance: 5n * ETH, pending: 4, latest: 3 });
    await ensureEnrolled(clients, nextNow());
    expect(writes).toEqual([]);
  });

  test("a second attempt inside the cooldown sends nothing", async () => {
    const t = nextNow();
    const { clients, writes } = fakeClients({ registered: true, stake: 100n, balance: 5n * ETH });
    await ensureEnrolled(clients, t);
    await ensureEnrolled(clients, t + 1000);
    expect(writes).toEqual(["addStake"]);
    await ensureEnrolled(clients, t + COOLDOWN + 1);
    expect(writes).toEqual(["addStake", "addStake"]);
  });
});

describe("hasPendingTx", () => {
  const client = (pending: number, latest: number) => ({
    getTransactionCount: async ({ blockTag }: { blockTag: "pending" | "latest" }) =>
      blockTag === "pending" ? pending : latest,
  });
  test("true when pending is ahead of latest", async () => {
    expect(await hasPendingTx(client(5, 4), ME)).toBe(true);
  });
  test("false when equal", async () => {
    expect(await hasPendingTx(client(4, 4), ME)).toBe(false);
  });
});

describe("waitForDrain", () => {
  test("drained when work finishes in time", async () => {
    expect(await waitForDrain(new Promise((r) => setTimeout(r, 5)), 500)).toBe("drained");
  });
  test("timeout when work outlasts the deadline", async () => {
    expect(await waitForDrain(new Promise((r) => setTimeout(r, 300)), 20)).toBe("timeout");
  });
  test("a rejected cycle still counts as drained", async () => {
    expect(await waitForDrain(Promise.reject(new Error("x")), 100)).toBe("drained");
  });
});
