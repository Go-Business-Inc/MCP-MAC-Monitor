#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBattery, getMemory, getCpu, getDisk, getTopProcesses, getEnergy, getSystemInfo, getSnapshot } from "./system.js";
import { schedulePowerAction, cancelScheduled, getScheduled, lockScreen, MIN_GRACE_SECONDS } from "./power.js";

const server = new McpServer({ name: "mac-monitor", version: "1.0.0" });

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const POWER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// ---------- Read-only ----------

server.registerTool(
  "get_snapshot",
  {
    title: "Estado general de la Mac",
    description:
      "Resumen completo de la Mac en una sola llamada: sistema, batería, memoria, CPU, disco y los 5 procesos que más CPU usan. Úsalo para preguntas generales como '¿cómo está la compu?'.",
    annotations: READ_ONLY,
  },
  async () => json({ ...(await getSnapshot()), scheduled_power_action: getScheduled() })
);

server.registerTool(
  "get_battery",
  {
    title: "Batería",
    description:
      "Batería: porcentaje, si está cargando, fuente de energía, tiempo restante, ciclos, salud (capacidad máxima vs. de fábrica), condición y temperatura.",
    annotations: READ_ONLY,
  },
  async () => json(await getBattery())
);

server.registerTool(
  "get_memory",
  {
    title: "Memoria RAM",
    description: "Memoria RAM: total, usada, memoria de apps, wired, comprimida, caché, swap y presión de memoria (normal/warning/critical).",
    annotations: READ_ONLY,
  },
  async () => json(await getMemory())
);

server.registerTool(
  "get_cpu",
  {
    title: "CPU",
    description: "CPU: chip, núcleos, uso actual (%), carga promedio 1/5/15 min y estado térmico.",
    annotations: READ_ONLY,
  },
  async () => json(await getCpu())
);

server.registerTool(
  "get_disk",
  {
    title: "Disco",
    description: "Espacio en disco: total, usado y libre del disco interno y de los discos externos montados.",
    annotations: READ_ONLY,
  },
  async () => json(await getDisk())
);

server.registerTool(
  "get_top_processes",
  {
    title: "Procesos con más consumo",
    description: "Procesos que más CPU o memoria consumen en este momento.",
    inputSchema: {
      sort_by: z.enum(["cpu", "memory"]).default("cpu").describe("Ordenar por uso de CPU o de memoria"),
      limit: z.number().int().min(1).max(50).default(10).describe("Cuántos procesos devolver"),
    },
    annotations: READ_ONLY,
  },
  async ({ sort_by, limit }) => json(await getTopProcesses({ sortBy: sort_by, limit }))
);

server.registerTool(
  "get_energy",
  {
    title: "Consumo de batería por programa",
    description:
      "Qué programas consumen más batería ahora mismo. energy_impact es el puntaje POWER de `top` (CPU y despertares; relativo, " +
      "no vatios) y NO incluye la GPU, por eso la lista se ordena por energy_impact + gpu_percent. Incluye % de CPU y de GPU de cada " +
      "programa, el uso total de la GPU y los programas que más GPU usan. Mide durante ~2 s. Úsalo para '¿qué se come la batería?'.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10).describe("Cuántos programas devolver"),
    },
    annotations: READ_ONLY,
  },
  async ({ limit }) => json(await getEnergy({ limit }))
);

server.registerTool(
  "get_system_info",
  {
    title: "Información del sistema",
    description: "Nombre de la Mac, modelo, chip, versión de macOS, usuario, tiempo encendida, modo de bajo consumo, IP local y hora actual.",
    annotations: READ_ONLY,
  },
  async () => json(await getSystemInfo())
);

// ---------- Power ----------

const delayMinutes = z
  .number()
  .min(0)
  .max(24 * 60)
  .default(0)
  .describe(`Minutos de espera antes de ejecutar. 0 = en ${MIN_GRACE_SECONDS} segundos (margen para que llegue la respuesta).`);

server.registerTool(
  "shutdown",
  {
    title: "Apagar la Mac",
    description:
      `Apaga la Mac de forma normal (como Menú Apple → Apagar), ahora o dentro de X minutos. Siempre espera al menos ${MIN_GRACE_SECONDS} s. ` +
      "Se puede cancelar con cancel_power_action mientras no se haya ejecutado. Si el apagado queda bloqueado (documento sin guardar, " +
      "una app que no se cierra), la Mac entra en reposo después de 2 minutos para no gastar batería (fallback_to_sleep). " +
      "Confirma con el usuario antes de usarlo si no lo pidió explícitamente.",
    inputSchema: {
      delay_minutes: delayMinutes,
      fallback_to_sleep: z.boolean().default(true).describe("Si el apagado queda bloqueado, poner la Mac en reposo"),
    },
    annotations: POWER,
  },
  async ({ delay_minutes, fallback_to_sleep }) =>
    json(schedulePowerAction("shutdown", { delayMinutes: delay_minutes, fallbackToSleep: fallback_to_sleep }))
);

server.registerTool(
  "restart",
  {
    title: "Reiniciar la Mac",
    description: `Reinicia la Mac de forma normal, ahora o dentro de X minutos (mínimo ${MIN_GRACE_SECONDS} s). Cancelable con cancel_power_action.`,
    inputSchema: { delay_minutes: delayMinutes },
    annotations: POWER,
  },
  async ({ delay_minutes }) => json(schedulePowerAction("restart", { delayMinutes: delay_minutes }))
);

server.registerTool(
  "sleep",
  {
    title: "Poner la Mac en reposo",
    description:
      `Pone la Mac en reposo (sleep), ahora o dentro de X minutos (mínimo ${MIN_GRACE_SECONDS} s). Casi no gasta batería y no cierra las apps. ` +
      "Ojo: al dormir, Claude en esta Mac deja de responder hasta que alguien la despierte. Cancelable con cancel_power_action.",
    inputSchema: { delay_minutes: delayMinutes },
    annotations: POWER,
  },
  async ({ delay_minutes }) => json(schedulePowerAction("sleep", { delayMinutes: delay_minutes }))
);

server.registerTool(
  "lock_screen",
  {
    title: "Apagar/bloquear pantalla",
    description:
      "Apaga la pantalla de inmediato. macOS la bloquea si está configurado para pedir contraseña al apagar la pantalla (por defecto sí). La Mac sigue encendida.",
    annotations: { ...POWER, destructiveHint: false },
  },
  async () => json(await lockScreen())
);

server.registerTool(
  "get_power_action",
  {
    title: "Ver apagado programado",
    description: "Indica si hay un apagado/reinicio/reposo programado y cuánto falta.",
    annotations: READ_ONLY,
  },
  async () => json({ scheduled: getScheduled() })
);

server.registerTool(
  "cancel_power_action",
  {
    title: "Cancelar apagado programado",
    description: "Cancela el apagado, reinicio o reposo programado, si todavía no se ejecutó.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const cancelled = cancelScheduled();
    return json(cancelled ? { cancelled } : { cancelled: null, message: "No había ninguna acción programada." });
  }
);

await server.connect(new StdioServerTransport());
