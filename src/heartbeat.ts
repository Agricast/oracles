import { writeFileSync } from "node:fs";

/**
 * Touch the heartbeat file named by HEARTBEAT_FILE (the Dockerfile sets it for the
 * container HEALTHCHECK). Unset means no heartbeat, so local runs write nothing.
 * Called after a cycle gets through its markets while the reporter is active,
 * so its mtime is "last time the loop got through a full cycle". Never throws: an unwritable path must not
 * take a working reporter down.
 */
export function writeHeartbeat(path: string | undefined = process.env.HEARTBEAT_FILE): void {
  if (!path) return;
  try {
    writeFileSync(path, `${Date.now()}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[heartbeat] could not write ${path}: ${(err as Error).message}`);
  }
}
