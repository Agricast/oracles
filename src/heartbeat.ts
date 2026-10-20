import { writeFileSync } from "node:fs";

/** File the container HEALTHCHECK looks at. Override with HEARTBEAT_FILE. */
export const DEFAULT_HEARTBEAT_FILE = "/tmp/reporter-heartbeat";

/**
 * Touch the heartbeat file. Called after a cycle completes without throwing, so
 * its mtime is "last time the loop got through a full cycle". Never throws: a
 * read-only /tmp must not take a working reporter down.
 */
export function writeHeartbeat(path: string = process.env.HEARTBEAT_FILE || DEFAULT_HEARTBEAT_FILE): void {
  try {
    writeFileSync(path, `${Date.now()}\n`);
  } catch (err) {
    console.warn(`[heartbeat] could not write ${path}: ${(err as Error).message}`);
  }
}
