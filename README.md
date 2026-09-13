# MCP Mac Monitor

A local [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) check the status of your Mac — battery, memory, CPU, GPU, disk, and which apps are draining your battery — and shut it down, restart it, or put it to sleep.

Ask things like *"How's my Mac doing?"*, *"What's eating my battery?"* or *"Shut down my Mac in 30 minutes"* — even from your phone, while Claude runs on the Mac.

## Tools

| Tool | What it does |
|---|---|
| `get_snapshot` | Everything at once: system, battery, memory, CPU, disk, top processes |
| `get_battery` | Charge %, charging state, time remaining, cycle count, health, temperature |
| `get_memory` | RAM used/total, compressed, swap, memory pressure |
| `get_cpu` | Usage %, load average, thermal state |
| `get_disk` | Free/used space per volume |
| `get_top_processes` | Processes using the most CPU or RAM |
| `get_energy` | Apps draining the most battery (energy impact + GPU %), with per-app CPU and GPU usage and total GPU usage |
| `get_system_info` | Model, chip, macOS version, uptime, local IP, current time |
| `shutdown` | Shut down now or in X minutes. If shutdown gets blocked, the Mac goes to sleep after 2 minutes |
| `restart` | Restart now or in X minutes |
| `sleep` | Sleep now or in X minutes |
| `lock_screen` | Turn the display off (locks it if a password is required on wake) |
| `get_power_action` / `cancel_power_action` | See / cancel a scheduled power action |

## Requirements

- macOS (Apple Silicon recommended — per-app GPU usage needs an Apple GPU)
- Node.js 18 or later
- No `sudo` required

## Installation

```bash
git clone https://github.com/Go-Business-Inc/MCP-MAC-Monitor.git
cd MCP-MAC-Monitor
npm install
```

### Claude Code

```bash
claude mcp add --scope user mac-monitor -- node /absolute/path/to/MCP-MAC-Monitor/src/index.js
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart Claude:

```json
{
  "mcpServers": {
    "mac-monitor": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/MCP-MAC-Monitor/src/index.js"]
    }
  }
}
```

Use the output of `which node` as `command` — Claude Desktop doesn't load your shell's `PATH`.

## Permissions

The first time the Mac shuts down or restarts, macOS asks for permission to let the app control **System Events**
(System Settings → Privacy & Security → Automation).

## Safety

- **60-second grace period.** Every power action waits at least 60 s, so the reply reaches you and there's time to call `cancel_power_action` if it was a mistake.
- **Survives Claude closing.** Scheduled actions run in a separate process (state in `~/.mac-monitor/scheduled.json`), so they execute even if Claude quits.
- **Blocked shutdowns fall back to sleep.** If an app refuses to quit (e.g. an unsaved document), the Mac sleeps after 2 minutes instead of draining the battery.
- **FileVault and remote restarts.** With FileVault on, a restarted Mac stops at the disk-unlock screen until someone types the password — Claude won't be reachable remotely until then.

## About the energy numbers

- `energy_impact` is the `POWER` value from `top` — the same kind of relative score as Activity Monitor's *Energy Impact* (not watts). It reflects CPU time and wakeups but **not GPU work**, so `get_energy` ranks apps by `energy_impact + gpu_percent`.
- Per-app GPU % comes from the GPU driver's per-process counters, sampled over ~2 seconds.
- Real wattage would require `powermetrics`, which needs `sudo`; this server intentionally avoids it.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `MAC_MONITOR_DRY_RUN` | — | Set to `1` to log power commands to `~/.mac-monitor/dry-run.log` instead of running them |
| `MAC_MONITOR_STATE_DIR` | `~/.mac-monitor` | Where scheduled-action state is stored |
| `MAC_MONITOR_FALLBACK_SECONDS` | `120` | How long a blocked shutdown waits before sleeping the Mac |

## Credits

Built by **[Go Business Inc.](https://gobusinessinc.com/)**

Go Business Inc. helps companies transform their operations through digital automation: process-based CRM and sales pipelines, AI chatbots and agents, automated marketing journeys, customer self-service portals, business intelligence dashboards, hardware automation, and remote-work management.
