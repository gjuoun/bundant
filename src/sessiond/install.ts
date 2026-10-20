import { createReadStream, statSync } from "node:fs";
import type { Runtime } from "../runtime.ts";
import type { RuntimeOps } from "../ops/types.ts";
import { checkArch } from "../preflight/arch.ts";
import { transferLocalImage, type TransferReport } from "../transfer/transfer.ts";
import { SESSIOND_CONTAINER, SESSIOND_LOG, sessiondImageFor, sessiondSpec } from "./plan.ts";

/**
 * Install is idempotent: removing the old container first means a re-run with a
 * new image can never leave the previous binary watching pids.
 */

export interface InstallRequest {
  host: string;
  ops: RuntimeOps;
  rt: Runtime;
  /** Explicit image ref; defaults to the per-arch tag of the built image. */
  image?: string;
  /** Local image archive (podman save / docker save) instead of a transfer. */
  from?: string;
  /** --allow-emulation: only honoured when the host has the matching binfmt. */
  allowEmulation: boolean;
}

export interface InstallResult {
  host: string;
  image: string;
  arch: string;
  emulated: boolean;
  transfer?: TransferReport;
  fromArchive?: boolean;
}

async function loadArchive(ops: RuntimeOps, path: string): Promise<void> {
  const size = statSync(path).size;
  await ops.loadImage(createReadStream(path), { contentLength: size });
}

export async function installOnHost(req: InstallRequest): Promise<InstallResult> {
  const hostPlatform = await req.ops.hostPlatform();
  if (hostPlatform === undefined) {
    throw new Error("cannot read the target platform on " + req.host + " (uname failed)");
  }
  const image = req.image ?? sessiondImageFor(hostPlatform.arch);

  let transfer: TransferReport | undefined;
  if (req.from !== undefined) {
    // Offline path: the archive is the only source, so a mismatch is caught on
    // the loaded image below instead of before the upload.
    await loadArchive(req.ops, req.from);
  } else {
    transfer = await transferLocalImage(req.ops, image, { rt: req.rt });
  }

  const imagePlatform = await req.ops.imagePlatform(image);
  if (imagePlatform === undefined) {
    throw new Error(
      "sessiond image " + image + " is not present on " + req.host +
        " after the transfer (tag the archive or pass --image)",
    );
  }
  const binfmtPresent = await req.ops.binfmtPresent(imagePlatform.arch);
  const verdict = checkArch({
    image,
    imagePlatform,
    hostPlatform,
    allowEmulation: req.allowEmulation,
    binfmtPresent,
  });

  await req.ops.removeContainer(SESSIOND_CONTAINER, { force: true });
  const id = await req.ops.createContainer(sessiondSpec(image));
  await req.ops.startContainer(id);

  return {
    host: req.host,
    image,
    arch: imagePlatform.arch,
    emulated: verdict.emulated,
    ...(transfer !== undefined ? { transfer } : {}),
    ...(req.from !== undefined ? { fromArchive: true } : {}),
  };
}

export async function removeOnHost(host: string, ops: RuntimeOps): Promise<{ host: string; removed: boolean }> {
  const rows = await ops.listContainers({ all: true });
  const present = rows.some((row) => row.name === SESSIOND_CONTAINER);
  if (present) await ops.removeContainer(SESSIOND_CONTAINER, { force: true });
  return { host, removed: present };
}

export { SESSIOND_LOG };
