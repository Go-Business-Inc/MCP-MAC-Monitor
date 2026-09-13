import os from "node:os";
import { run, sysctl, bytesToGB } from "./exec.js";

// ---------- Battery ----------

function parseIoreg(text) {
  const values = {};
  for (const m of text.matchAll(/"(\w+)" = (Yes|No|\d+)$/gm)) {
    const [, key, raw] = m;
    values[key] = raw === "Yes" ? true : raw === "No" ? false : BigInt(raw);
  }
  return values;
}

// ioreg prints signed 64-bit values (e.g. amperage while discharging) as unsigned.
const toSigned = (big) => Number(big >= 2n ** 63n ? big - 2n ** 64n : big);

export async function getBattery() {
  const [pmset, ioreg, profiler] = await Promise.all([
    run("/usr/bin/pmset", ["-g", "batt"]),
    run("/usr/sbin/ioreg", ["-rn", "AppleSmartBattery"]),
    run("/usr/sbin/system_profiler", ["SPPowerDataType"]),
  ]);

  const source = pmset.match(/Now drawing from '([^']+)'/)?.[1] ?? null;
  const line = pmset.match(/(\d+)%;\s*([^;]+);\s*([^\n]*)/);
  if (!line) return { present: false, power_source: source };

  const io = parseIoreg(ioreg);
  const num = (k) => (io[k] === undefined ? null : toSigned(io[k]));
  const remaining = line[3].match(/(\d+:\d+) remaining/)?.[1] ?? null;
  const design = num("DesignCapacity");
  const nominal = num("NominalChargeCapacity") ?? num("AppleRawMaxCapacity");

  return {
    present: true,
    percent: Number(line[1]),
    state: line[2].trim(), // charging | discharging | charged | AC attached; not charging
    power_source: source, // 'Battery Power' | 'AC Power'
    time_remaining: remaining, // h:mm, null while macOS is still estimating
    cycle_count: num("CycleCount"),
    condition: profiler.match(/Condition: (.+)/)?.[1]?.trim() ?? null,
    max_capacity_percent:
      Number(profiler.match(/Maximum Capacity: (\d+)%/)?.[1]) ||
      (design && nominal ? Math.round((nominal / design) * 100) : null),
    design_capacity_mah: design,
    current_full_capacity_mah: nominal,
    temperature_c: io.Temperature !== undefined ? num("Temperature") / 100 : null,
    voltage_v: io.Voltage !== undefined ? num("Voltage") / 1000 : null,
    amperage_ma: num("InstantAmperage") ?? num("Amperage"), // negative = discharging
    charger_connected: io.ExternalConnected ?? null,
  };
}

// ---------- Memory ----------

export async function getMemory() {
  const [vmStat, swap, pressureLevel, pressure] = await Promise.all([
    run("/usr/bin/vm_stat"),
    sysctl("vm.swapusage"),
    sysctl("kern.memorystatus_vm_pressure_level"),
    run("/usr/bin/memory_pressure", ["-Q"]),
  ]);

  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label) => Number(vmStat.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0) * pageSize;

  const total = os.totalmem();
  // Same breakdown Activity Monitor uses.
  const app = pages("Anonymous pages") - pages("Pages purgeable");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const cached = pages("File-backed pages") + pages("Pages purgeable");
  const used = app + wired + compressed;

  const swapMB = (k) => Number(swap.match(new RegExp(`${k} = ([\\d.]+)M`))?.[1] ?? 0);
  const level = { 1: "normal", 2: "warning", 4: "critical" }[pressureLevel] ?? pressureLevel;

  return {
    total_gb: bytesToGB(total),
    used_gb: bytesToGB(used),
    used_percent: Math.round((used / total) * 100),
    app_memory_gb: bytesToGB(app),
    wired_gb: bytesToGB(wired),
    compressed_gb: bytesToGB(compressed),
    cached_files_gb: bytesToGB(cached),
    swap_used_gb: Math.round((swapMB("used") / 1024) * 100) / 100,
    swap_total_gb: Math.round((swapMB("total") / 1024) * 100) / 100,
    pressure: level, // normal | warning | critical
    system_free_percent: Number(pressure.match(/free percentage: (\d+)%/)?.[1] ?? NaN) || null,
  };
}

// ---------- CPU ----------

export async function getCpu() {
  const [top, load, pCores, eCores, therm] = await Promise.all([
    // Two samples: the first one from `top` is an average since boot.
    run("/usr/bin/top", ["-l", "2", "-s", "1", "-n", "0"]),
    sysctl("vm.loadavg"),
    sysctl("hw.perflevel0.physicalcpu"),
    sysctl("hw.perflevel1.physicalcpu"),
    run("/usr/bin/pmset", ["-g", "therm"]),
  ]);

  const usage = [...top.matchAll(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/g)].at(-1);
  const [l1, l5, l15] = load.replace(/[{}]/g, "").trim().split(/\s+/).map(Number);
  const speedLimit = therm.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];

  return {
    chip: (await sysctl("machdep.cpu.brand_string")) || os.cpus()[0]?.model,
    cores: os.cpus().length,
    performance_cores: Number(pCores) || null,
    efficiency_cores: Number(eCores) || null,
    usage_percent: usage ? Math.round((100 - Number(usage[3])) * 10) / 10 : null,
    user_percent: usage ? Number(usage[1]) : null,
    system_percent: usage ? Number(usage[2]) : null,
    load_average: { "1m": l1, "5m": l5, "15m": l15 },
    thermal: speedLimit && Number(speedLimit) < 100 ? `throttled to ${speedLimit}%` : "normal",
  };
}

// ---------- Disk ----------

export async function getDisk() {
  const df = await run("/bin/df", ["-kP"]);
  const volumes = [];
  for (const line of df.split("\n").slice(1)) {
    const m = line.match(/^(\/dev\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
    if (!m) continue;
    const [, device, totalK, , availK, mount] = m;
    // The APFS data volume holds user files; other /System/Volumes/* are internal.
    const isMain = mount === "/System/Volumes/Data";
    if (!isMain && !mount.startsWith("/Volumes/")) continue;
    const total = Number(totalK) * 1024;
    const avail = Number(availK) * 1024;
    volumes.push({
      name: isMain ? "Macintosh HD" : mount.replace("/Volumes/", ""),
      mount,
      device,
      total_gb: bytesToGB(total),
      // APFS volumes share the container, so used = total - available.
      used_gb: bytesToGB(total - avail),
      free_gb: bytesToGB(avail),
      used_percent: Math.round(((total - avail) / total) * 100),
    });
  }
  return { volumes };
}

// ---------- Processes ----------

export async function getTopProcesses({ sortBy = "cpu", limit = 10 } = {}) {
  const out = await run("/bin/ps", ["-Aceo", "pid,pcpu,pmem,rss,comm", sortBy === "memory" ? "-m" : "-r"]);
  const processes = out
    .split("\n")
    .slice(1)
    .map((line) => line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .slice(0, limit)
    .map(([, pid, cpu, mem, rss, name]) => ({
      pid: Number(pid),
      name,
      cpu_percent: Number(cpu),
      memory_mb: Math.round(Number(rss) / 1024),
      memory_percent: Number(mem),
    }));
  return { sorted_by: sortBy, processes };
}

// ---------- Energy / GPU ----------

const ENERGY_SAMPLE_SECONDS = 2;

// Accumulated GPU time (ns) per pid, from the Apple GPU driver's per-client
// stats. Readable without sudo; empty on Macs without an Apple GPU.
async function gpuTimeByPid() {
  const out = await run("/usr/sbin/ioreg", ["-r", "-d", "1", "-w", "0", "-c", "AGXDeviceUserClient"]);
  const byPid = new Map();
  for (const client of out.split("+-o ").slice(1)) {
    const pid = Number(client.match(/"IOUserClientCreator" = "pid (\d+),/)?.[1]);
    if (!pid) continue;
    let ns = 0;
    for (const m of client.matchAll(/"accumulatedGPUTime"=(\d+)/g)) ns += Number(m[1]);
    byPid.set(pid, (byPid.get(pid) ?? 0) + ns);
  }
  return byPid;
}

export async function getEnergy({ limit = 10 } = {}) {
  const gpuBefore = await gpuTimeByPid();
  const start = process.hrtime.bigint();
  const [top, ps, pmset] = await Promise.all([
    // Two samples: the first one from `top` is an average since boot.
    // POWER is Activity Monitor's "Energy Impact". top orders each sample by
    // the previous one, so fetch every process and sort here.
    run("/usr/bin/top", ["-l", "2", "-s", String(ENERGY_SAMPLE_SECONDS), "-stats", "pid,cpu,power"]),
    // top truncates names to 16 chars; ps gives the full executable name.
    run("/bin/ps", ["-Aco", "pid,ppid,comm"]),
    run("/usr/bin/pmset", ["-g", "batt"]),
  ]);
  const gpuAfter = await gpuTimeByPid();
  const elapsedNs = Number(process.hrtime.bigint() - start);

  const procs = new Map();
  for (const line of ps.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
  }
  const gpuPercent = (pid) => {
    const delta = (gpuAfter.get(pid) ?? 0) - (gpuBefore.get(pid) ?? 0);
    // Sampling windows don't line up exactly, so cap at 100.
    return delta > 0 ? Math.min(100, Math.round((delta / elapsedNs) * 1000) / 10) : 0;
  };

  const lastSample = top.split(/^PID\s+%CPU\s+POWER\s*$/m).at(-1);
  const processes = lastSample
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\S*\s+([\d.]+)\s+([\d.]+)/))
    .filter(Boolean)
    .map(([, pidStr, cpu, power]) => {
      const pid = Number(pidStr);
      return {
        pid,
        name: procs.get(pid)?.name ?? null,
        energy_impact: Number(power),
        cpu_percent: Number(cpu),
        gpu_percent: gpuPercent(pid),
      };
    })
    // Skip the `top` we just spawned.
    .filter(({ pid }) => procs.get(pid)?.ppid !== process.pid)
    // top's POWER leaves out GPU work, so rank by both.
    .sort((a, b) => b.energy_impact + b.gpu_percent - (a.energy_impact + a.gpu_percent))
    .slice(0, limit);

  const gpuTop = [...gpuAfter.keys()]
    .map((pid) => ({ pid, name: procs.get(pid)?.name ?? null, gpu_percent: gpuPercent(pid) }))
    .filter((p) => p.gpu_percent > 0)
    .sort((a, b) => b.gpu_percent - a.gpu_percent)
    .slice(0, 5);
  // The driver's own "Device Utilization %" keeps its last value while the GPU
  // is idle, so derive the total from the per-process deltas instead.
  let gpuTotalNs = 0;
  for (const [pid, ns] of gpuAfter) gpuTotalNs += Math.max(0, ns - (gpuBefore.get(pid) ?? 0));

  return {
    sample_seconds: ENERGY_SAMPLE_SECONDS,
    power_source: pmset.match(/Now drawing from '([^']+)'/)?.[1] ?? null,
    gpu: {
      utilization_percent: gpuAfter.size ? Math.min(100, Math.round((gpuTotalNs / elapsedNs) * 1000) / 10) : null,
      top_processes: gpuTop,
    },
    processes,
  };
}

// ---------- System info ----------

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

export async function getSystemInfo() {
  const [name, model, version, build, lowPower, wifiIp, ethIp] = await Promise.all([
    run("/usr/sbin/scutil", ["--get", "ComputerName"]),
    sysctl("hw.model"),
    run("/usr/bin/sw_vers", ["-productVersion"]),
    run("/usr/bin/sw_vers", ["-buildVersion"]),
    run("/usr/bin/pmset", ["-g"]),
    run("/usr/sbin/ipconfig", ["getifaddr", "en0"]),
    run("/usr/sbin/ipconfig", ["getifaddr", "en1"]),
  ]);

  return {
    computer_name: name.trim(),
    model,
    chip: await sysctl("machdep.cpu.brand_string"),
    macos: `${version.trim()} (${build.trim()})`,
    user: os.userInfo().username,
    uptime: formatUptime(os.uptime()),
    booted_at: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    low_power_mode: /lowpowermode\s+1/.test(lowPower),
    local_ip: wifiIp.trim() || ethIp.trim() || null,
    now: new Date().toString(),
  };
}

// ---------- Everything at once ----------

export async function getSnapshot() {
  const [system, battery, memory, cpu, disk, top] = await Promise.all([
    getSystemInfo(),
    getBattery(),
    getMemory(),
    getCpu(),
    getDisk(),
    getTopProcesses({ sortBy: "cpu", limit: 5 }),
  ]);
  return { system, battery, memory, cpu, disk, top_processes_by_cpu: top.processes };
}
