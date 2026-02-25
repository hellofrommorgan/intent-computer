/**
 * stdin.ts — Read and parse JSON from stdin
 *
 * Claude Code hooks receive their input as a single JSON blob on stdin.
 * This helper reads it all, parses it, and returns the typed result.
 */

import type { HookInput } from "./types.js";

export async function readStdin<T extends HookInput>(): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        if (!raw) {
          // No stdin — return a minimal stub so hooks can still run
          resolve({
            session_id: "unknown",
            transcript_path: "",
            cwd: process.cwd(),
            hook_event_name: "unknown",
          } as T);
          return;
        }
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Failed to parse stdin JSON: ${err}`));
      }
    });
    process.stdin.on("error", reject);

    // If stdin is a TTY (manual testing), don't hang forever
    if (process.stdin.isTTY) {
      resolve({
        session_id: "manual",
        transcript_path: "",
        cwd: process.cwd(),
        hook_event_name: "manual",
      } as T);
    }
  });
}
