import type { ContainerRow, HostResult, InspectRow, StatRow } from "./monitor.ts";

/** Plain-text renderers for the monitoring CLI. One host block each, aligned. */

function pad(rows: string[][], widths: number[]): string[] {
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}

function widths(rows: string[][]): number[] {
  const w: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      w[i] = Math.max(w[i] ?? 0, cell.length);
    });
  }
  return w;
}

function hostBlock(label: string, body: string[]): string[] {
  return ["== " + label + " ==", ...body.map((l) => "  " + l)];
}

export function renderContainers(hosts: HostResult<ContainerRow>[]): string {
  const out: string[] = [];
  for (const h of hosts) {
    if (!h.ok) {
      out.push(...hostBlock(h.host, ["unreachable — " + (h.error ?? "unknown error")]));
      continue;
    }
    if (h.rows.length === 0) {
      out.push(...hostBlock(h.host, ["no containers"]));
      continue;
    }
    const table = h.rows.map((r) => [r.name, r.image, r.status, r.ports]);
    const w = widths([["name", "image", "status", "ports"], ...table]);
    out.push(...hostBlock(h.host, pad(table, w)));
  }
  return out.join("\n");
}

export function renderStats(hosts: HostResult<StatRow>[]): string {
  const out: string[] = [];
  for (const h of hosts) {
    if (!h.ok) {
      out.push(...hostBlock(h.host, ["unreachable — " + (h.error ?? "unknown error")]));
      continue;
    }
    if (h.rows.length === 0) {
      out.push(...hostBlock(h.host, ["no running containers"]));
      continue;
    }
    const table = h.rows.map((r) => [r.name, r.cpu, r.mem, r.memPct, r.pids]);
    const w = widths([["name", "cpu", "mem", "mem%", "pids"], ...table]);
    out.push(...hostBlock(h.host, pad(table, w)));
  }
  return out.join("\n");
}

export function renderInspect(hosts: HostResult<InspectRow>[]): string {
  const out: string[] = [];
  for (const h of hosts) {
    if (!h.ok || h.rows.length === 0) {
      out.push(...hostBlock(h.host, [h.ok ? "no container" : "unreachable — " + (h.error ?? "")]));
      continue;
    }
    const r = h.rows[0]!;
    out.push(
      ...hostBlock(h.host, [
        "name          " + r.name,
        "state         " + r.state + (r.health !== "-" ? "  health=" + r.health : ""),
        "restarts      " + r.restarts + "  exitCode=" + r.exitCode,
        "started       " + r.startedAt,
        "image         " + r.image,
        "restart policy " + r.restartPolicy + "  log driver=" + r.logDriver,
      ]),
    );
  }
  return out.join("\n");
}
