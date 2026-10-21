/**
 * CPU platform vocabulary shared by engine detection, image inspect and the
 * deploy preflight. uname, docker and podman all spell the same architecture
 * differently (x86_64 / amd64, aarch64 / arm64), so every producer funnels
 * through normalizeArch before anything compares platforms.
 */

export interface Platform {
  os: string;
  arch: string;
  /** arm64 "v8", arm "v7"; absent when the producer does not say. */
  variant?: string;
}

const ARCH_ALIASES: Record<string, string> = {
  x86_64: "amd64",
  x86_64_v2: "amd64",
  amd64: "amd64",
  aarch64: "arm64",
  aarch64_be: "arm64",
  arm64: "arm64",
  armv8l: "arm64",
  armv7l: "arm",
  armv6l: "arm",
  armv5tel: "arm",
  arm: "arm",
  i386: "386",
  i486: "386",
  i586: "386",
  i686: "386",
  x86: "386",
};

/** Canonical engine spelling (OCI platform names). Unknown input is kept. */
export function normalizeArch(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (text === "") return "";
  return ARCH_ALIASES[text] ?? text;
}

export function normalizeOs(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Fold an inspect-style pair into a Platform, or undefined if either is missing. */
export function parsePlatform(
  os: unknown,
  arch: unknown,
  variant?: unknown,
): Platform | undefined {
  if (typeof os !== "string" || typeof arch !== "string") return undefined;
  const normalizedOs = normalizeOs(os);
  const normalizedArch = normalizeArch(arch);
  if (normalizedOs === "" || normalizedArch === "") return undefined;
  const detail = typeof variant === "string" && variant.trim() !== "" ? variant.trim() : undefined;
  return {
    os: normalizedOs,
    arch: normalizedArch,
    ...(detail !== undefined ? { variant: detail } : {}),
  };
}

/** Human side of a mismatch: "linux/amd64 (image app:t1)". */
export function formatPlatform(platform: Platform): string {
  return platform.os + "/" + platform.arch + (platform.variant !== undefined ? "/" + platform.variant : "");
}
