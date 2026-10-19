import type { RuntimeEvent, StatsSample } from "./adapters/types.ts";

/** Plain values the monitoring tables render; kept out of the data source. */

/** 1536 -> "1.50KiB"; both engines report binary units in their tables. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 2;
  return value.toFixed(digits) + units[unit];
}

export interface StatRow {
  host: string;
  name: string;
  cpu: string;
  mem: string;
  memPct: string;
  pids: string;
}

/** StatsSample -> the columns the stats table and UI already render. */
export function statRow(host: string, name: string, sample: StatsSample): StatRow {
  const memPct = sample.memoryLimitBytes > 0 ? (sample.memoryUsageBytes / sample.memoryLimitBytes) * 100 : 0;
  return {
    host,
    name,
    cpu: sample.cpuPercent.toFixed(2) + "%",
    mem: formatBytes(sample.memoryUsageBytes) + " / " + formatBytes(sample.memoryLimitBytes),
    memPct: memPct.toFixed(2) + "%",
    pids: String(sample.pids),
  };
}

/** One RuntimeEvent -> the "time|type|action|name" line the UI prints. */
export function formatEvent(event: RuntimeEvent): string {
  const name = event.actor?.attributes?.name ?? event.id ?? "";
  return event.time + "|" + event.type + "|" + event.action + "|" + name;
}
