import { DockerAdapter } from "./docker.ts";
import type { RuntimeKind } from "../runtime.ts";

/**
 * Podman speaks the Docker-compatible API, so the read-only surface is the
 * same. Endpoints where compat is lossy (for example container stats details)
 * will be overridden here with explicit /libpod/... calls in later stages.
 */
export class PodmanAdapter extends DockerAdapter {
  override readonly kind: RuntimeKind = "podman";
}
