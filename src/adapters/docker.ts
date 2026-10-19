import type { ApiClient, ApiQuery } from "./api.ts";
import { demuxStream } from "./api.ts";
import type { RuntimeKind } from "../runtime.ts";
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

/**
 * Docker over the engine API (read-only in stage 1). Podman reuses this class:
 * its Docker-compatible endpoints answer the same requests, and the places
 * where the compat API is lossy move to explicit /libpod paths in the adapter
 * subclasses later — never at the call sites.
 */

interface ApiContainerSummary {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
  Created?: number;
}

interface ApiInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: { Status?: string; Running?: boolean; ExitCode?: number; StartedAt?: string };
  HostConfig?: { RestartPolicy?: { Name?: string }; Binds?: string[]; NetworkMode?: string };
}

interface ApiStats {
  read?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number };
  pids_stats?: { current?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

interface ApiVersionBody {
  Version?: string;
}

export class DockerAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind = "docker";

  constructor(
    protected readonly client: ApiClient,
    readonly engineVersion: string,
    readonly apiVersion: string,
  ) {}

  // ----- images (stages 4-5) ------------------------------------------------

  async pull(_ref: string): Promise<void> {
    throw new NotImplementedInStage1("pull");
  }

  async loadImage(_stream: NodeJS.ReadableStream): Promise<void> {
    throw new NotImplementedInStage1("loadImage");
  }

  async removeImage(_ref: string): Promise<void> {
    throw new NotImplementedInStage1("removeImage");
  }

  // ----- containers (mutations arrive in stage 3) ---------------------------

  async create(_spec: ContainerSpec): Promise<{ id: string }> {
    throw new NotImplementedInStage1("create");
  }

  async start(_id: string): Promise<void> {
    throw new NotImplementedInStage1("start");
  }

  async stop(_id: string, _timeoutSeconds?: number): Promise<void> {
    throw new NotImplementedInStage1("stop");
  }

  async remove(_id: string, _opts?: { force?: boolean; volumes?: boolean }): Promise<void> {
    throw new NotImplementedInStage1("remove");
  }

  async inspect(id: string): Promise<ContainerInfo> {
    const raw = await this.getJson<ApiInspect>("/containers/" + encodeURIComponent(id) + "/json");
    return {
      id: raw.Id ?? id,
      name: (raw.Name ?? id).replace(/^\//, ""),
      image: raw.Config?.Image ?? "",
      state: {
        status: raw.State?.Status ?? "unknown",
        running: raw.State?.Running === true,
        exitCode: raw.State?.ExitCode ?? 0,
        startedAt: raw.State?.StartedAt,
      },
      labels: raw.Config?.Labels ?? {},
      env: raw.Config?.Env ?? [],
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? "no",
      binds: raw.HostConfig?.Binds ?? [],
      networkMode: raw.HostConfig?.NetworkMode ?? "",
      raw,
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

    const rows = await this.getJson<ApiContainerSummary[]>("/containers/json", query);
    return rows.map((row) => ({
      id: row.Id ?? "",
      name: (row.Names?.[0] ?? "").replace(/^\//, ""),
      image: row.Image ?? "",
      state: row.State ?? "",
      status: row.Status ?? "",
      labels: row.Labels ?? {},
      created: row.Created ?? 0,
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
      for await (const frame of demuxStream(res)) yield frame.data.toString("utf8");
    })();
  }

  async stats(id: string): Promise<StatsSample> {
    const raw = await this.getJson<ApiStats>("/containers/" + encodeURIComponent(id) + "/stats", {
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

  async exec(_id: string, _argv: string[], _opts?: { tty?: boolean }): Promise<ExecResult> {
    throw new NotImplementedInStage1("exec");
  }

  // ----- volumes / networks (stage 5) ---------------------------------------

  async createVolume(_name: string, _labels: Record<string, string>): Promise<void> {
    throw new NotImplementedInStage1("createVolume");
  }

  async removeVolume(_name: string): Promise<void> {
    throw new NotImplementedInStage1("removeVolume");
  }

  async inspectVolume(name: string): Promise<{ labels: Record<string, string> }> {
    const raw = await this.getJson<{ Labels?: Record<string, string> | null }>(
      "/volumes/" + encodeURIComponent(name),
    );
    return { labels: raw.Labels ?? {} };
  }

  async ensureNetwork(_name: string): Promise<void> {
    throw new NotImplementedInStage1("ensureNetwork");
  }

  // ----- events -------------------------------------------------------------

  events(opts: { since?: string; until?: string; labels?: Record<string, string> } = {}): AsyncIterable<RuntimeEvent> {
    const client = this.client;
    const query: ApiQuery = {};
    if (opts.since !== undefined) query.since = opts.since;
    if (opts.until !== undefined) query.until = opts.until;
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
            yield JSON.parse(text) as RuntimeEvent;
          } catch {
            // A partial line cannot happen here (we only take complete lines);
            // ignore a malformed event rather than kill the stream.
          }
        }
      }
    })();
  }

  protected async getJson<T>(path: string, query?: ApiQuery): Promise<T> {
    const res = await this.client.request("GET", path, undefined, query);
    return res.json as T;
  }

  /** /version is already cached on the adapter; kept for later stages. */
  protected async probeVersion(): Promise<string> {
    const body = await this.getJson<ApiVersionBody>("/version");
    return body.Version ?? this.engineVersion;
  }
}
