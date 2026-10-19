/**
 * Docker and Podman accept `since`/`until` as **epoch seconds** (they run
 * `strconv.ParseInt` on the value — a duration like "1h" is rejected). Operators
 * think in durations, so the adapters take `number | string` and convert here.
 */

/** "90s" | "15m" | "2h" | "7d" | "1h30m" -> seconds. */
export function durationToSeconds(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const re = /(\d+(?:\.\d+)?)\s*([smhdw])/gi;
  let total = 0;
  let matched = "";
  for (const m of trimmed.matchAll(re)) {
    const value = Number(m[1]);
    const unit = (m[2] ?? "").toLowerCase();
    const factor = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 604800;
    total += value * factor;
    matched += m[0];
  }
  if (matched.replace(/\s/g, "") !== trimmed.replace(/\s/g, "")) return undefined;
  return Math.round(total);
}

/** Epoch seconds for "1h", "1700000000", or a Date. */
export function toEpochSeconds(value: number | string | Date, now = Date.now()): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value);
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") return Math.floor(asNumber);
  const duration = durationToSeconds(value);
  if (duration === undefined) {
    throw new Error("cannot read '" + value + "' as a duration (1h, 30m) or epoch seconds");
  }
  return Math.floor(now / 1000) - duration;
}
