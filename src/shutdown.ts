/**
 * Waits for `work` to settle, but no longer than `deadlineMs`. Resolves
 * "drained" if it settled in time, "timeout" otherwise. Never rejects.
 */
export async function waitForDrain(work: Promise<unknown>, deadlineMs: number): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  try {
    return await Promise.race([work.then(() => "drained" as const, () => "drained" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when this account has a transaction in the mempool that no block has
 * mined yet (pending nonce ahead of the latest one). Sending another stake
 * transaction in that state would double the top-up.
 */
export async function hasPendingTx(
  client: { getTransactionCount: (args: { address: `0x${string}`; blockTag: "pending" | "latest" }) => Promise<number> },
  address: `0x${string}`,
): Promise<boolean> {
  const [pending, latest] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "pending" }),
    client.getTransactionCount({ address, blockTag: "latest" }),
  ]);
  return pending > latest;
}
