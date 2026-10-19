import type { DeployPlan } from "./planner.ts";

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
