import { ArchMismatchError } from "../agent/errors.ts";
import { formatPlatform, normalizeArch, type Platform } from "../platform.ts";

/**
 * Arch preflight: the image is loaded by diffID and says nothing about the CPU
 * it needs, so a foreign image loads fine and only dies at start - or, worse,
 * runs silently under qemu when binfmt is registered. The comparison happens
 * before the deploy lock and before the first container mutation.
 */

export interface ArchVerdict {
  emulated: boolean;
  image: Platform;
  host: Platform;
}

export interface CheckArchInput {
  image: string;
  imagePlatform: Platform;
  hostPlatform: Platform;
  allowEmulation: boolean;
  /** /proc/sys/fs/binfmt_misc/qemu-<arch> exists on the target. */
  binfmtPresent: boolean;
}

/** The binfmt registration name matches the IMAGE arch, not the host's. */
export function binfmtPath(imageArch: string): string {
  return "/proc/sys/fs/binfmt_misc/qemu-" + normalizeArch(imageArch);
}

/** Same os and same canonical arch. A variant mismatch is not fatal on its own. */
export function platformsMatch(image: Platform, host: Platform): boolean {
  return image.os === host.os && image.arch === host.arch;
}

export function mismatchMessage(input: CheckArchInput): string {
  const sides =
    "image " + input.image + " is " + formatPlatform(input.imagePlatform) +
    " but host " + formatPlatform(input.hostPlatform);
  if (input.allowEmulation && !input.binfmtPresent) {
    return "arch mismatch: " + sides + " and " + binfmtPath(input.imagePlatform.arch) + " is absent";
  }
  return "arch mismatch: " + sides;
}

/**
 * Throw ARCH_MISMATCH unless the platforms agree. --allow-emulation is only an
 * escape hatch when the target can actually execute the foreign arch; without
 * a binfmt entry the container would fail at start, so it stays an error.
 */
export function checkArch(input: CheckArchInput): ArchVerdict {
  if (platformsMatch(input.imagePlatform, input.hostPlatform)) {
    return { emulated: false, image: input.imagePlatform, host: input.hostPlatform };
  }
  const details = {
    image: input.image,
    imagePlatform: formatPlatform(input.imagePlatform),
    hostPlatform: formatPlatform(input.hostPlatform),
  };
  if (!input.allowEmulation) {
    throw new ArchMismatchError({
      message: mismatchMessage(input) + " (pass --allow-emulation to run under qemu)",
      ...details,
    });
  }
  if (!input.binfmtPresent) {
    throw new ArchMismatchError({
      message: mismatchMessage(input) + " - emulation refused because the host cannot execute it",
      ...details,
    });
  }
  return { emulated: true, image: input.imagePlatform, host: input.hostPlatform };
}

export function emulationWarning(verdict: ArchVerdict, host: string): string {
  return "warning: " + host + " has no native " + verdict.image.arch +
    "; running " + formatPlatform(verdict.image) + " under qemu emulation";
}
