import type { DeployPlan } from "./planner.ts";
import { splitImageRef } from "./adapters/docker.ts";

/** Render a plan for humans (dry-run). Env values never appear here. */
export function renderPlan(plan: DeployPlan): string {
  const lines: string[] = [];
  const m = plan.meta;
  lines.push(
    "bundant deploy plan — " + m.service + "/" + m.role + " rev=" + m.revision +
    " runtime=" + m.runtime + " image=" + m.image,
  );
  if (m.envRemotePath) {
    lines.push(
      "env: " + m.envCount + " inline vars" + (m.envHasFile ? " + env file (values redacted)" : "") +
      " -> " + m.envRemotePath,
    );
  }
  lines.push("hosts: " + m.hosts.join(", "));
  lines.push("");
  lines.push("lock (" + m.hosts[0] + "):");
  lines.push("  " + plan.lockStep.cmds[0]);
  if (m.envRemotePath) {
    lines.push("");
    lines.push("env upload (each host, putFile, values redacted):");
    lines.push("  local merged env -> " + m.envRemotePath + " (mode 0600)");
  }
  for (const host of m.hosts) {
    lines.push("");
    lines.push("host " + host + ":");
    let i = 1;
    for (const step of plan.hostSteps) {
      lines.push("  " + i + ") [" + step.phase + "] " + step.desc);
      for (const c of step.cmds) lines.push("     " + c.replaceAll("{HOST}", host));
      i++;
    }
  }
  lines.push("");
  lines.push("unlock:");
  lines.push("  " + plan.unlockStep.cmds[0]);
  return lines.join("\n");
}

export interface ApiPlanOptions {
  /** Values that go into the Env array (never printed). */
  envCount: number;
}

function labelsFor(plan: DeployPlan, replica: number): Record<string, string> {
  const m = plan.meta;
  return {
    "bundant.service": m.service,
    "bundant.group": m.group ?? "default",
    "bundant.kind": "service",
    "bundant.revision": m.revision,
    "bundant.replica": String(replica),
  };
}

const redactedEnv = (count: number): string =>
  count === 0 ? "[]" : "<" + count + " value(s) redacted>";

/**
 * Dry-run for \`--via api\`: the complete engine-API call plan, not shell
 * strings. Nothing is sent; env values are rendered as a redacted count. The
 * two ssh-level steps that remain are shown as such (lock and runtime checks).
 */
export function renderApiPlan(plan: DeployPlan, opts: ApiPlanOptions): string {
  const m = plan.meta;
  const lines: string[] = [];
  lines.push(
    "bundant deploy plan (via api) — " + m.service + "/" + m.role + " rev=" + m.revision +
    " runtime=" + m.runtime + " image=" + m.image,
  );
  lines.push(
    "env: " + opts.envCount + " value(s) redacted, passed as ContainerSpec.Env " +
    "(no remote env file is written)",
  );
  lines.push("hosts: " + m.hosts.join(", "));
  lines.push("");
  lines.push("lock (" + m.hosts[0] + ", ssh): " + plan.lockStep.cmds[0]);
  const image = splitImageRef(m.image);
  const pullQuery = "?fromImage=" + encodeURIComponent(image.fromImage) +
    (image.tag !== undefined ? "&tag=" + encodeURIComponent(image.tag) : "");
  const filters = encodeURIComponent(JSON.stringify({
    label: [
      "bundant.service=" + m.service,
      "bundant.group=" + (m.group ?? "default"),
      "bundant.kind=service",
    ],
  }));

  for (const host of m.hosts) {
    lines.push("");
    lines.push("host " + host + ":");
    let i = 1;
    lines.push("  " + i++ + ") [ssh] host prerequisites (systemd units, sysctl floor) — same as today");
    if (m.localImage !== undefined) {
      lines.push("  " + i++ + ") [cli] --local-image streaming still uses save|gzip|ssh|load (stage 4)");
    } else {
      lines.push("  " + i++ + ") [pull] POST /images/create" + pullQuery + " (progress stream drained)");
    }
    lines.push("  " + i++ + ") [network] POST /networks/create {\"Name\":\"bundant\",\"CheckDuplicate\":true} (409 = exists)");
    lines.push("  " + i++ + ") [run] per container:");
    m.containerNames.forEach((name, index) => {
      const body = {
        name,
        image: m.image,
        labels: labelsFor(plan, index + 1),
        env: redactedEnv(opts.envCount),
        restart: "unless-stopped",
        network: "bundant",
      };
      lines.push("       POST /containers/create?name=" + name + " " + JSON.stringify(body));
      lines.push("       POST /containers/" + name + "/start");
    });
    lines.push(
      "  " + i++ + ") [health] for each " + m.containerNames.join(", ") + ":",
    );
    lines.push(
      "       POST /containers/create?name=bundant-probe-…. {image:\"curlimages/curl:8.11.1\", " +
      "network:\"bundant\", cmd:[\"-w\",\"%{http_code}\", …]}",
    );
    lines.push("       POST /containers/<probe>/start -> GET /containers/<probe>/json until exit");
    lines.push("       GET /containers/<probe>/logs -> DELETE /containers/<probe>?force=1");
    if (plan.hostSteps.some((s) => s.phase === "proxy-ensure")) {
      lines.push(
        "  " + i++ + ") [proxy-ensure] GET /containers/kamal-proxy/json -> " +
        "POST /containers/kamal-proxy/start | POST /containers/create {ports:80,443}",
      );
      const argv = ["kamal-proxy", "deploy", m.serviceId];
      for (const name of m.containerNames) argv.push("--target", name + ":" + m.proxyPort);
      lines.push(
        "  " + i++ + ") [proxy-swap] POST /containers/kamal-proxy/exec " +
        JSON.stringify({ Cmd: argv }) + "  (one atomic target-set swap)",
      );
    }
    lines.push(
      "  " + i++ + ") [stop-old] GET /containers/json?all=1&filters=" + filters +
      " -> POST /containers/<old>/stop?t=10 (accessories skipped by label)",
    );
  }
  lines.push("");
  lines.push("unlock (ssh): " + plan.unlockStep.cmds[0]);
  return lines.join("\n");
}
