import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LoadedConfig } from "./config.ts";
import { monitorFor, type Monitor } from "./monitor.ts";
import { UI_PAGE } from "./ui-page.ts";

/**
 * `bundant ui` - a local, read-only monitoring page. The process you start is
 * the only thing that talks to the hosts (over the same ssh connection as
 * everything else); nothing is installed on them and nothing is persisted.
 * History shown in the page is what this session observed, and it dies with it.
 */

export interface UiOptions {
  port: number;
  bind?: string;
  /** Overridable for tests. */
  monitor?: Monitor;
}

function json(res: ServerResponse, body: unknown, code = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function query(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v === null ? undefined : v;
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function uiHandler(monitor: Monitor): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    void (async (): Promise<void> => {
      try {
        if (path === "/" || path === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(UI_PAGE);
          return;
        }
        if (path === "/api/hosts") {
          const containers = await monitor.containers();
          const byHost: Record<string, string[]> = {};
          for (const h of containers) byHost[h.host] = h.rows.map((r) => r.name);
          json(res, { hosts: monitor.hosts, containers: byHost });
          return;
        }
        if (path === "/api/snapshot") {
          json(res, { hosts: await monitor.containers() });
          return;
        }
        if (path === "/api/stats") {
          json(res, { hosts: await monitor.stats() });
          return;
        }
        if (path === "/api/proxy") {
          json(res, { hosts: await monitor.proxyRoutes() });
          return;
        }
        if (path === "/api/inspect") {
          const selector = query(url, "container") ?? "";
          json(res, { hosts: await monitor.inspect(selector) });
          return;
        }
        if (path === "/api/logs") {
          const host = query(url, "host");
          if (host === undefined) {
            json(res, { ok: false, error: "host is required" });
            return;
          }
          try {
            const text = await monitor.logs(host, query(url, "container") ?? "", intOr(query(url, "tail"), 200));
            json(res, { ok: true, text });
          } catch (e) {
            json(res, { ok: false, error: (e as Error).message });
          }
          return;
        }
        if (path === "/api/events") {
          const host = query(url, "host");
          if (host === undefined) {
            json(res, { ok: false, error: "host is required" });
            return;
          }
          try {
            const lines = await monitor.events(host, query(url, "since") ?? "2h", { windowSeconds: 3 });
            json(res, { ok: true, lines });
          } catch (e) {
            json(res, { ok: false, error: (e as Error).message });
          }
          return;
        }
        json(res, { ok: false, error: "not found: " + path }, 404);
      } catch (e) {
        json(res, { ok: false, error: (e as Error).message }, 500);
      }
    })();
  };
}

/** Start the local UI and keep it running until SIGINT. */
export async function ui(loaded: LoadedConfig, opts: UiOptions): Promise<number> {
  const monitor = opts.monitor ?? (await monitorFor(loaded));
  const bind = opts.bind ?? "127.0.0.1";
  const server = createServer(uiHandler(monitor));

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, bind, resolve);
  });

  console.log("bundant ui - http://" + bind + ":" + opts.port);
  console.log("  hosts: " + monitor.hosts.join(", "));
  console.log("  read-only, pull-on-demand: every query is one ssh round trip per host; nothing runs on them");
  console.log("  remote access: ssh -L " + opts.port + ":127.0.0.1:" + opts.port + " <host> (or tailscale)");

  return await new Promise<number>((resolve) => {
    const stop = (): void => {
      server.close(() => {
        void monitor.close().finally(() => resolve(0));
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
