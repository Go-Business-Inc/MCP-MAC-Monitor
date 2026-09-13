import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";

const STATE_DIR = process.env.MAC_MONITOR_STATE_DIR ?? path.join(os.homedir(), ".mac-monitor");
const STATE_FILE = path.join(STATE_DIR, "scheduled.json");
const DRY_RUN_LOG = path.join(STATE_DIR, "dry-run.log");
// MAC_MONITOR_DRY_RUN=1 logs the commands instead of running them (for testing).
const DRY_RUN = process.env.MAC_MONITOR_DRY_RUN === "1";

// Even "now" waits a minute so the reply reaches Claude (and your phone)
// before the Mac goes down, and there's time to cancel a mistaken request.
export const MIN_GRACE_SECONDS = 60;
// If a graceful shutdown is blocked (unsaved document, permission prompt, an
// app refusing to quit), sleep the Mac after this long so it stops draining.
const FALLBACK_SECONDS = Number(process.env.MAC_MONITOR_FALLBACK_SECONDS ?? 120);

const COMMANDS = {
  shutdown: `/usr/bin/osascript -e 'tell application "System Events" to shut down'`,
  restart: `/usr/bin/osascript -e 'tell application "System Events" to restart'`,
  sleep: `/usr/bin/pmset sleepnow`,
};

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const cmd = (c) => (DRY_RUN ? `echo "$(date '+%F %T') WOULD RUN: ${c.replaceAll('"', '\\"')}" >> ${shellQuote(DRY_RUN_LOG)}` : c);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function describe(state) {
  const secondsLeft = Math.max(0, Math.round((new Date(state.execute_at) - Date.now()) / 1000));
  return {
    action: state.action,
    execute_at: new Date(state.execute_at).toString(),
    seconds_left: secondsLeft,
    minutes_left: Math.round((secondsLeft / 60) * 10) / 10,
    fallback_to_sleep: state.fallback_to_sleep,
  };
}

export function getScheduled() {
  const state = readState();
  if (!state) return null;
  if (!isAlive(state.pid)) {
    fs.rmSync(STATE_FILE, { force: true });
    return null;
  }
  return describe(state);
}

export function cancelScheduled() {
  const state = readState();
  fs.rmSync(STATE_FILE, { force: true });
  if (!state || !isAlive(state.pid)) return null;
  try {
    process.kill(-state.pid, "SIGTERM"); // whole process group: shell + its sleep
  } catch {
    process.kill(state.pid, "SIGTERM");
  }
  return describe(state);
}

// Runs the action from a detached shell so it survives Claude (and this MCP
// server) being closed, and can still be cancelled by PID.
export function schedulePowerAction(action, { delayMinutes = 0, fallbackToSleep = true } = {}) {
  const replaced = cancelScheduled();
  const delaySeconds = Math.max(MIN_GRACE_SECONDS, Math.round(delayMinutes * 60));
  const useFallback = fallbackToSleep && action === "shutdown";

  const script = [
    `/bin/sleep ${delaySeconds}`,
    `/bin/rm -f ${shellQuote(STATE_FILE)}`,
    useFallback ? `${cmd(COMMANDS[action])} &` : cmd(COMMANDS[action]),
    ...(useFallback ? [`/bin/sleep ${FALLBACK_SECONDS}`, cmd(COMMANDS.sleep)] : []),
  ].join("\n");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();

  const state = {
    action,
    pid: child.pid,
    scheduled_at: new Date().toISOString(),
    execute_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    fallback_to_sleep: useFallback,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return { scheduled: describe(state), replaced, dry_run: DRY_RUN };
}

// Turns the display off; macOS locks it if "require password after screen
// saver/display off" is set to immediately (the default).
export async function lockScreen() {
  if (DRY_RUN) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(DRY_RUN_LOG, `${new Date().toISOString()} WOULD RUN: pmset displaysleepnow\n`);
  } else {
    await run("/usr/bin/pmset", ["displaysleepnow"]);
  }
  return { display_off: true, dry_run: DRY_RUN };
}
