import type { LoadedConfig } from "./config.ts";
import type { DeployPlan } from "./planner.ts";
import type { ContainerSpec } from "./adapters/types.ts";
import type { Platform } from "./platform.ts";
import type { Executor } from "./types.ts";
import { groupLabels } from "./planner.ts";
import { LABEL_EMULATED } from "./labels.ts";
import { NETWORK } from "./commands/docker.ts";
import { defaultControlDir } from "./host/session.ts";
import { LocalExecutor } from "./exec/local.ts";
import { SshExecutor, connectOptionsFor } from "./exec/ssh.ts";
import { connectionForTarget } from "./hosts.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { openOps, type PullPolicy, type RuntimeOps } from "./ops/index.ts";
import { assertPreflight } from "./validation.ts";
import { runtimeFor } from "./runtime.ts";
import { checkArch, emulationWarning, platformsMatch, type ArchVerdict } from "./preflight/arch.ts";
import { defaultArchPreflight, type ArchPreflight } from "./preflight/probe.ts";
import {
  resolveLocalImage,
  transferLocalImage,
  type TransferReport,
} from "./transfer/transfer.ts";
import { resolveLocalImagePlatform } from "./transfer/layers.ts";

export interface DeployOptions {
  /** Test seam: the factory runs only after preflight passes. */
  openPrimary?: () => SshExecutor;
  /** v2: allow two units that differ only by case. */
  allowCaseCollision?: boolean;
  /** missing (default) skips a pull when the image is present. */
  pullPolicy?: PullPolicy;
  /** Per-phase milliseconds, written for --timings / --json. */
  phases?: Record<string, number>;
  /** Receives the image-transfer report per host (delta or full). */
  onTransfer?: (host: string, report: TransferReport) => void;
  /** --allow-emulation: downgrade ARCH_MISMATCH only when binfmt can execute it. */
  allowEmulation?: boolean;
  /** Test seam: the read-only arch probe that runs before the deploy lock. */
  archPreflight?: ArchPreflight;
  /** Written before any mutation, for --json / status reporting. */
  outcome?: DeployOutcome;
  /** Test seam: the local engine shell used for the image preflight. */
  localExec?: Executor;
  /** Test seam: the transfer the deploy would run (counts calls in tests). */
  localImageTransfer?: (ops: RuntimeOps, ref: string) => Promise<TransferReport>;
}

export interface DeployOutcome {
  emulated?: boolean;
}

export interface DeployOnHostOptions {
  host: string;
  allowCaseCollision?: boolean;
  pullPolicy?: PullPolicy;
  phases?: Record<string, number>;
  /** --local-image over the engine API (delta stream, fallback inside). */
  localImageTransfer?: (ops: RuntimeOps) => Promise<TransferReport>;
  onTransfer?: (host: string, report: TransferReport) => void;
  allowEmulation?: boolean;
  /** Called once when the image is foreign but provably emulatable. */
  onEmulation?: (verdict: ArchVerdict) => void;
}

/**
 * Compare the image the host actually received with the host itself. This is
 * the registry half of the preflight: a single-arch tag pulled onto a foreign
 * host must fail as ARCH_MISMATCH, never as an engine start error.
 */
async function enforceImageArch(
  ops: RuntimeOps,
  image: string,
  host: string,
  allowEmulation: boolean,
  /** The operator-facing ref (the engine id is not a useful error). */
  label = image,
): Promise<ArchVerdict | undefined> {
  const [imagePlatform, hostPlatform] = await Promise.all([
    ops.imagePlatform(image),
    ops.hostPlatform(),
  ]);
  if (imagePlatform === undefined || hostPlatform === undefined) return undefined;
  if (platformsMatch(imagePlatform, hostPlatform)) return undefined;
  const binfmtPresent = allowEmulation ? await ops.binfmtPresent(imagePlatform.arch) : false;
  const verdict = checkArch({
    image: label,
    imagePlatform,
    hostPlatform,
    allowEmulation,
    binfmtPresent,
  });
  console.log("[" + host + "] " + emulationWarning(verdict, host));
  return verdict;
}

function timed(phases: Record<string, number> | undefined, phase: string, start: number): void {
  if (phases !== undefined) phases[phase] = (phases[phase] ?? 0) + performance.now() - start;
}

/** Apply the image pull policy through RuntimeOps. */
export async function pullForPolicy(
  ops: Pick<RuntimeOps, "imagePresent" | "pull">,
  image: string,
  policy: PullPolicy,
): Promise<"pulled" | "present"> {
  const present = await ops.imagePresent(image);
  if (policy === "never") {
    if (!present) throw new Error("image not present on host: " + image + " (--pull never)");
    return "present";
  }
  if (policy === "always" || !present) {
    await ops.pull(image);
    return "pulled";
  }
  return "present";
}

export interface ExistingUnit {
  name: string;
  labels: Record<string, string>;
}

/**
 * Case-only duplicates are unsafe on case-insensitive DNS/hosts. Compare the
 * host's labelled units by (group, service), not by full container name: a
 * redeploy changes the revision, which would hide the collision.
 */
export function findCaseCollision(
  rows: ExistingUnit[],
  planned: { group?: string; service: string },
): string | undefined {
  const group = planned.group !== undefined && planned.group !== "" ? planned.group : "default";
  const unit = group + "/" + planned.service;
  for (const row of rows) {
    const rowGroup = row.labels["bundant.group"];
    const rowService = row.labels["bundant.service"];
    if (rowGroup === undefined || rowService === undefined) continue;
    if (rowGroup.toLowerCase() !== group.toLowerCase()) continue;
    if (rowService.toLowerCase() !== planned.service.toLowerCase()) continue;
    if (rowGroup === group && rowService === planned.service) continue;
    const existing = rowGroup + "/" + rowService;
    return existing + " and " + unit + " both resolve to " + unit.toLowerCase();
  }
  return undefined;
}

/** Turn a merged KEY=VAL file into the engine's Env array (values stay redacted in logs). */
export function envArray(content: string | null): string[] {
  if (content === null || content.trim() === "") return [];
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    out.push(text.slice(0, eq) + "=" + text.slice(eq + 1));
  }
  return out;
}

/**
 * One host's deploy on top of RuntimeOps. The ordering is the zero-downtime
 * contract: create + start the new revision, gate it, swap the proxy target
 * set once, then stop the old revision. Any failure removes only what this
 * run started and leaves traffic on the old revision.
 */
export async function deployOnHost(
  ops: RuntimeOps,
  plan: DeployPlan,
  loaded: LoadedConfig,
  opts: DeployOnHostOptions,
): Promise<void> {
  const m = plan.meta;
  const host = opts.host;
  const env = envArray(loaded.envContent);

  const rows = await ops.listContainers({ all: true });
  if (opts.allowCaseCollision !== true) {
    const collision = findCaseCollision(rows, {
      group: loaded.config.group,
      service: loaded.config.service,
    });
    if (collision !== undefined) throw new Error("case-collision: " + collision);
  }
  const existingNames = new Set(rows.map((row) => row.name));

  await ops.putEnv(m.envRemotePath, loaded.envCount);

  const prereqStart = performance.now();
  await ops.hostPrereqs();
  timed(opts.phases, "connect", prereqStart);
  let imageForSpec = m.image;
  if (opts.localImageTransfer !== undefined) {
    const transferStart = performance.now();
    const report = await opts.localImageTransfer(ops);
    timed(opts.phases, "transfer", transferStart);
    opts.onTransfer?.(host, report);
    imageForSpec = (await ops.imageId(m.image)) ?? m.image;
    console.log(
      "[" + host + "] image transfer ok (" + report.mode +
        ", layers reused " + report.layersReused + "/" + report.layersTotal +
        ", " + report.bytesSent + " bytes sent" +
        (report.fallback !== undefined ? ", fallback: " + report.fallback : "") + ")",
    );
  } else {
    const policy = opts.pullPolicy ?? "missing";
    const pullStart = performance.now();
    const pull = await pullForPolicy(ops, m.image, policy);
    timed(opts.phases, "pull", pullStart);
    console.log(
      "[" + host + "] " +
        (pull === "pulled" ? "pull ok (policy=" + policy + ")" : "pull skipped (present, policy=" + policy + ")"),
    );
  }

  // Must precede every container mutation: the image loads by diffID and the
  // architecture only surfaces at start (or silently under qemu).
  const emulated = await enforceImageArch(
    ops,
    imageForSpec,
    host,
    opts.allowEmulation === true,
    m.localImage ?? m.image,
  );
  if (emulated !== undefined) opts.onEmulation?.(emulated);

  const networkStart = performance.now();
  await ops.ensureNetwork();
  timed(opts.phases, "network", networkStart);
  console.log("[" + host + "] network ok");

  const created: string[] = [];
  const createStart = performance.now();
  try {
    for (let i = 0; i < m.containerNames.length; i++) {
      const name = m.containerNames[i]!;
      const labels = groupLabels(loaded.config, m.revision, i + 1);
      if (emulated !== undefined) labels[LABEL_EMULATED] = "true";
      const spec: ContainerSpec = {
        image: imageForSpec,
        name,
        env,
        labels,
        network: NETWORK,
        restart: "unless-stopped",
      };
      created.push(name);
      // Only the same revision already on the host needs the rm -f; a brand new
      // revision skips a 404 round-trip.
      if (existingNames.has(name)) await ops.removeContainer(name, { force: true });
      const id = await ops.createContainer(spec);
      await ops.startContainer(id);
    }
    timed(opts.phases, "create", createStart);
    console.log("[" + host + "] run ok: " + m.containerNames.join(", "));

    const healthStart = performance.now();
    await ops.healthGate(m.containerNames, {
      path: m.healthcheck.path,
      port: m.healthcheck.port,
      timeoutMs: m.healthcheck.timeout * 1000,
    });
    timed(opts.phases, "health", healthStart);
    console.log("[" + host + "] health gate passed (" + m.containerNames.length + " target(s))");

    if (loaded.config.proxy.enabled) {
      const proxyStart = performance.now();
      await ops.proxyEnsure(loaded.config.proxy.image);
      console.log("[" + host + "] proxy-ensure ok");
      const targets = m.containerNames.map(
        (n) => n + ":" + loaded.config.proxy.port,
      );
      const proxyOpts = {
        host: loaded.config.proxy.host,
        tls: loaded.config.proxy.tls,
        healthCheckPath: loaded.config.healthcheck.path,
        healthCheckPort:
          loaded.config.healthcheck.port === loaded.config.proxy.port
            ? undefined
            : loaded.config.healthcheck.port,
      };
      await ops.proxyDeploy(m.serviceId, targets, proxyOpts);
      console.log("[" + host + "] proxy-swap ok");
      timed(opts.phases, "proxy", proxyStart);
    }

    const stopStart = performance.now();
    await ops.stopOld(loaded.config, m.containerNames);
    timed(opts.phases, "stop-old", stopStart);
    console.log("[" + host + "] stop-old ok");
  } catch (e) {
    for (const name of created) {
      try {
        await ops.removeContainer(name, { force: true });
      } catch {
        // best-effort cleanup; the original failure is the useful error
      }
    }
    console.log(
      "[" + host + "] aborted, removed containers started by this run (" +
        created.join(", ") + ")",
    );
    throw e;
  }
}

/** Orchestrates the planned sequence per host under the hosts[0] deploy lock. */
export async function deploy(
  plan: DeployPlan,
  loaded: LoadedConfig,
  opts: DeployOptions = {},
): Promise<number> {
  const m = plan.meta;

  // Preflight first: an invalid config must never create a connection or a lock.
  const preflightStart = performance.now();
  assertPreflight(loaded);

  const local = m.localImage ? (opts.localExec ?? new LocalExecutor()) : null;
  const rt = runtimeFor(loaded.config.runtime);
  const transferOverride = opts.localImageTransfer;

  // Local image facts are resolved BEFORE ssh and before any transfer. The
  // image platform used to be read after the ssh session existed, and a podman
  // inspect template failure (no .Variant) silently skipped the check until
  // after the image had already been loaded into the host store.
  let localPlatform: Platform | undefined;
  if (m.localImage && local) {
    localPlatform = await resolveLocalImagePlatform(m.localImage, rt, local);
    try {
      await resolveLocalImage(m.localImage, rt, local);
    } catch {
      throw new Error(
        "local image not found: " + m.localImage + " - build or pull it first (" +
          rt.bin + " images)",
      );
    }
    if (localPlatform === undefined) {
      throw new Error(
        "cannot read the local image platform for " + m.localImage +
          " - refusing to deploy before the host is touched",
      );
    }
  }

  const primary = opts.openPrimary !== undefined
    ? opts.openPrimary()
    : new SshExecutor({
        ...connectOptionsFor(connectionForTarget(loaded.config, m.hosts[0]!)),
        controlDir: defaultControlDir(),
        controlPersistSec: 60,
        persist: true,
      });
  timed(opts.phases, "preflight", preflightStart);
  const execs = new Set<SshExecutor>([primary]);
  let locked = false;

  try {
    // Read-only arch preflight: the local side is already resolved above; the
    // host side is one uname, and the verdict still lands before the lock and
    // before any engine call or transfer.
    const archStart = performance.now();
    const archProbe = opts.archPreflight ?? defaultArchPreflight;
    const arch = await archProbe({
      image: m.localImage ?? m.image,
      isLocal: m.localImage !== undefined,
      allowEmulation: opts.allowEmulation === true,
      exec: primary,
      rt,
      ...(local !== null ? { local } : {}),
      ...(localPlatform !== undefined ? { imagePlatform: localPlatform } : {}),
    });
    timed(opts.phases, "arch", archStart);
    if (arch?.emulated === true && opts.outcome !== undefined) opts.outcome.emulated = true;

    const lockStart = performance.now();
    await acquireLock(primary, m.lockKey);
    timed(opts.phases, "lock", lockStart);
    // A second exec on the same connection measures reuse (not the handshake,
    // which the lock call above already paid).
    const sshStart = performance.now();
    await primary.run("true");
    timed(opts.phases, "ssh", sshStart);
    locked = true;
    console.log(
      "deploy " + m.service + "/" + m.role + " rev=" + m.revision + " -> " +
        m.hosts.join(", "),
    );

    for (const host of m.hosts) {
      console.log("[" + host + "] deploying " + m.containerNames.join(", "));
      const connectStart = performance.now();
      const ops = await openOps(connectionForTarget(loaded.config, host), loaded.config);
      timed(opts.phases, "connect", connectStart);
      try {
        await deployOnHost(ops, plan, loaded, {
          host,
          localImageTransfer: m.localImage !== undefined
            ? (hosterOps) =>
                transferOverride !== undefined
                  ? transferOverride(hosterOps, m.localImage!)
                  : transferLocalImage(hosterOps, m.localImage!, {
                      rt: runtimeFor(loaded.config.runtime),
                    })
            : undefined,
          onTransfer: opts.onTransfer,
          allowEmulation: opts.allowEmulation,
          onEmulation: () => {
            if (opts.outcome !== undefined) opts.outcome.emulated = true;
          },
          allowCaseCollision: opts.allowCaseCollision,
          pullPolicy: opts.pullPolicy,
          phases: opts.phases,
        });
      } finally {
        const closeStart = performance.now();
        await ops.close();
        timed(opts.phases, "disconnect", closeStart);
      }
    }

    console.log(
      "deployed " + m.containerNames.join(", ") + " on " + m.hosts.length + " host(s)",
    );
    return 0;
  } finally {
    const releaseStart = performance.now();
    if (locked) await releaseLock(primary, m.lockKey);
    for (const e of execs) await e.close();
    timed(opts.phases, "release", releaseStart);
  }
}
