import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs a command and returns stdout. Never throws: returns "" on failure so a
// single missing metric doesn't break a whole report.
export async function run(cmd, args = [], { timeout = 10_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    return err.stdout ?? "";
  }
}

export async function sysctl(name) {
  return (await run("/usr/sbin/sysctl", ["-n", name])).trim();
}

export const bytesToGB = (bytes) => Math.round((bytes / 1024 ** 3) * 100) / 100;
