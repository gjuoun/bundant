import { z } from "zod";
import { ApiError, type ApiClient, type ApiQuery } from "./api.ts";
import { toEpochSeconds } from "./time.ts";
import { demuxStream } from "./api.ts";
import type { RuntimeKind } from "../runtime.ts";
import {
  eventSchema,
  inspectSchema,
  parseOrDrift,
  statsSchema,
  summaryListSchema,
  volumeSchema,
  type ParseContext,
} from "./schemas/index.ts";
import {
  NotImplementedInStage1,
  type ContainerInfo,
  type ContainerSpec,
  type ContainerSummary,
  type ExecResult,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StatsSample,
} from "./types.ts";

/** ContainerSummary.Ports -> the CLI's "0.0.0.0:80->80/tcp, 443/tcp" form. */
export function formatPorts(
  ports: readonly { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[] | undefined,
): string {
  return (ports ?? [])
    .map((port) => {
      const target = port.PublicPort === undefined
        ? String(port.PrivatePort)
        : (port.IP !== undefined && port.IP !== "" ? port.IP : "0.0.0.0") + ":" + port.PublicPort + "->" + port.PrivatePort;
      return target + "/" + port.Type;
    })
    .join(", ");
}

/**
 * Docker over the engine API (read-only in stage 1). Podman reuses this class:
 * its Docker-compatible endpoints answer the same requests, and the places
 * where the compat API is lossy move to explicit /libpod paths in the adapter
 * subclasses later - never at the call sites.
 */

export class DockerAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind = "docker";
  protected readonly client: ApiClient;
  readonly engineVersion: string;
  readonly apiVersion: string;

  constructor(client: ApiClient, engineVersion: string, apiVersion: string) {
    this.client = client;
    this.engineVersion = engineVersion;
    this.apiVersion = apiVersion;
  }

  // ----- images -------------------------------------------------------------

  async pull(ref: string): Promise<void> {
    const { fromImage, tag } = splitImageRef(ref);
    const query: ApiQuery = { fromImage };
    if (tag !== undefined) query.tag = tag;
    // The pull response is a progress stream; draining it is what waits for
    // completion. A 4xx/5xx has already become an ApiError in requestStream.
    const res = await this.client.requestStream("POST", "/images/create", undefined, query);
    for await (const _chunk of res) {
      // progress output is intentionally discarded
    }
  }

  async imagePresent(ref: string): Promise<boolean> {
    try {
      await this.client.request("GET", "/images/" + encodeURIComponent(ref) + "/json");
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      throw err;
    }
  }

  async loadImage(_stream: NodeJS.ReadableStream): Promise<void> {
    throw new NotImplementedInStage1("loadImage");
  }

  async removeImage(ref: string): Promise<void> {
    await this.client.request("DELETE", "/images/" + encodeURIComponent(ref), undefined, { force: 1 });
  }

  async pruneImages(): Promise<void> {
    await this.client.request("POST", "/images/prune", undefined, {
      filters: JSON.stringify({ dangling: { "true": true } }),
    });
  }

  // ----- containers ---------------------------------------------------------

  async create(spec: ContainerSpec): Promise<{ id: string }> {
    const body = createBody(spec);
    const res = await this.client.request(
      "POST",
      "/containers/create",
      body,
      { name: spec.name },
    );
    const parsed = createResponse.safeParse(res.json);
    if (!parsed.success) {
      throw new Error("engine API POST /containers/create returned no container id");
    }
    return { id: parsed.data.Id };
  }

  async start(id: string): Promise<void> {
    await this.client.request("POST", "/containers/" + encodeURIComponent(id) + "/start");
  }

  async stop(id: string, timeoutSeconds = 10): Promise<void> {
    await this.client.request(
      "POST",
      "/containers/" + encodeURIComponent(id) + "/stop",
      undefined,
      { t: timeoutSeconds },
    );
  }

  async remove(id: string, opts: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    const query: ApiQuery = {};
    if (opts.force === true) query.force = 1;
    if (opts.volumes === true) query.v = 1;
    try {
      await this.client.request("DELETE", "/containers/" + encodeURIComponent(id), undefined, query);
    } catch (err) {
      // Removing an absent container is a no-op for the deploy path (rm -f).
      if (err instanceof ApiError && err.status === 404) return;
      throw err;
    }
  }

  async inspect(id: string): Promise<ContainerInfo> {
    const path = "/containers/" + encodeURIComponent(id) + "/json";
    const res = await this.client.request("GET", path);
    const raw = parseOrDrift(inspectSchema, res.json, this.context("GET", path));
    return {
      id: raw.Id ?? id,
      name: (raw.Name ?? id).replace(/^\//, ""),
      image: raw.Config?.Image ?? "",
      state: {
        status: raw.State?.Status ?? "unknown",
        running: raw.State?.Running === true,
        exitCode: raw.State?.ExitCode ?? 0,
        startedAt: raw.State?.StartedAt,
        restarts: raw.RestartCount ?? 0,
        health: raw.State?.Health?.Status,
      },
      labels: raw.Config?.Labels ?? {},
      env: raw.Config?.Env ?? [],
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? "no",
      logDriver: raw.HostConfig?.LogConfig?.Type ?? "",
      binds: raw.HostConfig?.Binds ?? [],
      networkMode: raw.HostConfig?.NetworkMode ?? "",
      raw: res.json,
    };
  }

  async list(opts: {
    all?: boolean;
    labels?: Record<string, string>;
    namePrefix?: string;
  }): Promise<ContainerSummary[]> {
    const filters: Record<string, string[]> = {};
    const labels = Object.entries(opts.labels ?? {}).map(([k, v]) => k + "=" + v);
    if (labels.length > 0) filters.label = labels;
    if (opts.namePrefix !== undefined) filters.name = [opts.namePrefix];
    const query: ApiQuery = { all: opts.all === true ? 1 : 0 };
    if (Object.keys(filters).length > 0) query.filters = JSON.stringify(filters);

    const rows = await this.getJson(summaryListSchema, "/containers/json", query);
    return rows.map((row) => ({
      id: row.Id ?? "",
      name: (row.Names?.[0] ?? "").replace(/^\//, ""),
      image: row.Image ?? "",
      state: row.State ?? "",
      status: row.Status ?? "",
      labels: row.Labels ?? {},
      created: row.Created ?? 0,
      ports: formatPorts(row.Ports),
    }));
  }

  logs(id: string, opts: { tail?: number; follow?: boolean } = {}): AsyncIterable<string> {
    const client = this.client;
    const path = "/containers/" + encodeURIComponent(id) + "/logs";
    const query: ApiQuery = {
      stdout: 1,
      stderr: 1,
      follow: opts.follow === true ? 1 : 0,
      tail: opts.tail ?? "all",
    };
    return (async function* () {
      const res = await client.requestStream("GET", path, undefined, query);
      // Frames are not line-aligned: buffer the partial tail across frames so
      // callers get whole lines and never half a log record.
      let pending = "";
      for await (const frame of demuxStream(res)) {
        pending += frame.data.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      if (pending !== "") yield pending;
    })();
  }

  async stats(id: string): Promise<StatsSample> {
    const raw = await this.getJson(statsSchema, "/containers/" + encodeURIComponent(id) + "/stats", {
      stream: 0,
      "one-shot": 1,
    });
    const cpu = raw.cpu_stats;
    const pre = raw.precpu_stats;
    const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
    const online = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * online * 100 : 0;
    const networks: StatsSample["networks"] = {};
    for (const [name, net] of Object.entries(raw.networks ?? {})) {
      networks[name] = { rxBytes: net.rx_bytes ?? 0, txBytes: net.tx_bytes ?? 0 };
    }
    return {
      readAt: raw.read ?? new Date().toISOString(),
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsageBytes: raw.memory_stats?.usage ?? 0,
      memoryLimitBytes: raw.memory_stats?.limit ?? 0,
      pids: raw.pids_stats?.current ?? 0,
      networks,
    };
  }

  async exec(id: string, argv: string[], opts: { tty?: boolean } = {}): Promise<ExecResult> {
    const created = await this.client.request(
      "POST",
      "/containers/" + encodeURIComponent(id) + "/exec",
      { AttachStdout: true, AttachStderr: true, Tty: opts.tty === true, Cmd: argv },
    );
    const execId = execCreateResponse.safeParse(created.json);
    if (!execId.success) {
      throw new Error("engine API POST /containers/" + id + "/exec returned no exec id");
    }
    const stream = await this.client.requestStream(
      "POST",
      "/exec/" + encodeURIComponent(execId.data.Id) + "/start",
      { Detach: false, Tty: opts.tty === true },
    );
    let stdout = "";
    let stderr = "";
    for await (const frame of demuxStream(stream)) {
      if (frame.stream === "stderr") stderr += frame.data.toString("utf8");
      else stdout += frame.data.toString("utf8");
    }
    const inspected = await this.client.request(
      "GET",
      "/exec/" + encodeURIComponent(execId.data.Id) + "/json",
    );
    const parsed = execInspectSchema.safeParse(inspected.json);
    const code = parsed.success ? (parsed.data.ExitCode ?? 0) : 0;
    return { code, stdout, stderr };
  }

  // ----- volumes / networks (stage 5) ---------------------------------------

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    try {
      await this.client.request("POST", "/volumes/create", { Name: name, Labels: labels });
    } catch (err) {
      // Existing volume with the same name is the desired state.
      if (err instanceof ApiError && err.status === 409) return;
      throw err;
    }
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.client.request("DELETE", "/volumes/" + encodeURIComponent(name));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return;
      throw err;
    }
  }

  async inspectVolume(name: string): Promise<{ labels: Record<string, string> }> {
    const raw = await this.getJson(volumeSchema, "/volumes/" + encodeURIComponent(name));
    return { labels: raw.Labels };
  }

  async ensureNetwork(name: string): Promise<void> {
    try {
      await this.client.request("POST", "/networks/create", {
        Name: name,
        CheckDuplicate: true,
      });
    } catch (err) {
      // 409 = the network already exists, which is the desired state.
      if (err instanceof ApiError && err.status === 409) return;
      throw err;
    }
  }

  // ----- events -------------------------------------------------------------

  events(opts: { since?: number | string; until?: number | string; labels?: Record<string, string> } = {}): AsyncIterable<RuntimeEvent> {
    const client = this.client;
    const self = this;
    const query: ApiQuery = {};
    // the engines require epoch seconds; callers may pass "1h" or a timestamp
    if (opts.since !== undefined) query.since = String(toEpochSeconds(opts.since));
    if (opts.until !== undefined) query.until = String(toEpochSeconds(opts.until));
    const labels = Object.entries(opts.labels ?? {}).map(([k, v]) => k + "=" + v);
    if (labels.length > 0) query.filters = JSON.stringify({ label: labels });

    return (async function* () {
      const res = await client.requestStream("GET", "/events", undefined, query);
      let pending = "";
      for await (const chunk of res) {
        pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (text === "") continue;
          try {
            const raw = parseOrDrift(eventSchema, JSON.parse(text), { engine: self.kind, method: "GET", path: "/events" });
            yield {
              type: raw.Type,
              action: raw.Action,
              id: raw.Actor?.ID,
              time: raw.time,
              timeNano: raw.timeNano,
              actor: raw.Actor === undefined
                ? undefined
                : { id: raw.Actor.ID, attributes: raw.Actor.Attributes },
            };
          } catch (err) {
            if (err instanceof SyntaxError) {
              // A malformed line is not shape drift; ignore it rather than kill the stream.
              continue;
            }
            throw err;
          }
        }
      }
    })();
  }

  protected context(method: string, path: string): ParseContext {
    return { engine: this.kind, method, path };
  }

  protected async getJson<T extends z.ZodTypeAny>(
    schema: T,
    path: string,
    query?: ApiQuery,
  ): Promise<z.infer<T>> {
    const res = await this.client.request("GET", path, undefined, query);
    return parseOrDrift(schema, res.json, this.context("GET", path));
  }
}

const createResponse = z.object({ Id: z.string() });
const execCreateResponse = z.object({ Id: z.string() });
const execInspectSchema = z.object({ ExitCode: z.number().nullish() });

/** "repo:tag" | "registry:5000/repo:tag" | "repo@sha256:..." -> create params. */
export function splitImageRef(ref: string): { fromImage: string; tag?: string } {
  if (ref.includes("@")) return { fromImage: ref };
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { fromImage: ref };
}

/** "hostPort:containerPort[/proto]" -> ExposedPorts + PortBindings entries. */
function portBindings(ports: string[] | undefined): {
  exposed: Record<string, Record<string, never>>;
  bindings: Record<string, { HostPort: string }[]>;
} {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, { HostPort: string }[]> = {};
  for (const entry of ports ?? []) {
    const [mapping, proto = "tcp"] = entry.split("/");
    const [hostPort, containerPort] = (mapping ?? "").split(":");
    if (!hostPort || !containerPort) continue;
    const key = containerPort + "/" + proto;
    exposed[key] = {};
    bindings[key] = [{ HostPort: hostPort }];
  }
  return { exposed, bindings };
}

/** ContainerSpec -> the engine's create payload (the same semantics as \`run\`). */
export function createBody(spec: ContainerSpec): Record<string, unknown> {
  const { exposed, bindings } = portBindings(spec.ports);
  const hostConfig: Record<string, unknown> = {
    RestartPolicy: { Name: spec.restart ?? "unless-stopped" },
  };
  if (spec.volumes !== undefined && spec.volumes.length > 0) hostConfig.Binds = spec.volumes;
  if (spec.network !== undefined) hostConfig.NetworkMode = spec.network;
  if (Object.keys(bindings).length > 0) hostConfig.PortBindings = bindings;
  if (spec.sysctl !== undefined && Object.keys(spec.sysctl).length > 0) hostConfig.Sysctls = spec.sysctl;

  const body: Record<string, unknown> = {
    Image: spec.image,
    Env: spec.env,
    Labels: spec.labels,
    HostConfig: hostConfig,
  };
  if (spec.cmd !== undefined && spec.cmd.length > 0) body.Cmd = spec.cmd;
  if (Object.keys(exposed).length > 0) body.ExposedPorts = exposed;
  if (spec.network !== undefined) {
    body.NetworkingConfig = { EndpointsConfig: { [spec.network]: {} } };
  }
  return body;
}

