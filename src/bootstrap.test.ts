import { describe, expect, test } from "bun:test";
import {
  HostBootstrap,
  installCommands,
  packageFamily,
  parseProbe,
  planBootstrap,
  probeCommand,
  type BootstrapProbe,
  type OsRelease,
} from "./bootstrap.ts";
import type { ExecResult, Executor } from "./types.ts";

function probeOutput(fields: Record<string, string>, bins: string[]): string {
  return [
    ...Object.entries(fields).map(([k, v]) => "BUNDANT_OS " + k + "=" + v),
    ...bins.map((b) => "BUNDANT_BIN " + b),
  ].join("\n");
}

const ubuntuLxc = probeOutput(
  {
    ID: "ubuntu",
    ID_LIKE: "debian",
    VERSION_ID: "24.04",
    PRETTY_NAME: "Ubuntu 24.04.2 LTS",
    container: "lxc",
  },
  ["apt-get", "systemctl"],
);

const fedoraReady = probeOutput(
  { ID: "fedora", ID_LIKE: "", VERSION_ID: "41", PRETTY_NAME: "Fedora Linux 41", container: "" },
  ["podman", "dnf", "systemctl"],
);

function os(id: string, idLike: string[] = [], versionId = ""): OsRelease {
  return { id, idLike, versionId, prettyName: id };
}

describe("parseProbe", () => {
  test("ubuntu LXC without podman", () => {
    const p = parseProbe(ubuntuLxc);
    expect(p.os.id).toBe("ubuntu");
    expect(p.os.idLike).toEqual(["debian"]);
    expect(p.os.versionId).toBe("24.04");
    expect(p.os.prettyName).toBe("Ubuntu 24.04.2 LTS");
    expect(p.family).toBe("apt");
    expect(p.hasPodman).toBe(false);
    expect(p.hasSystemd).toBe(true);
    expect(p.inContainer).toBe("lxc");
  });

  test("fedora with podman already installed", () => {
    const p = parseProbe(fedoraReady);
    expect(p.family).toBe("dnf");
    expect(p.hasPodman).toBe(true);
    expect(p.inContainer).toBe("");
  });

  test("garbage output degrades to unknown instead of throwing", () => {
    const p = parseProbe("");
    expect(p.family).toBe("unknown");
    expect(p.hasPodman).toBe(false);
    expect(p.os.prettyName).toBe("unknown");
  });
});

describe("probeCommand", () => {
  test("single round trip, no shell-unsafe interpolation", () => {
    const cmd = probeCommand();
    expect(cmd).toContain("/etc/os-release");
    expect(cmd).toContain("BUNDANT_BIN");
    expect(cmd).toContain("command -v");
  });
});

describe("packageFamily", () => {
  const all = ["apt-get", "dnf", "yum", "apk", "pacman", "zypper", "systemctl"];

  test("known distributions pick their native manager", () => {
    expect(packageFamily(os("ubuntu"), all)).toBe("apt");
    expect(packageFamily(os("debian", [], "12"), all)).toBe("apt");
    expect(packageFamily(os("rocky", [], "9.4"), all)).toBe("dnf");
    expect(packageFamily(os("fedora", [], "41"), all)).toBe("dnf");
    expect(packageFamily(os("amzn", [], "2023"), all)).toBe("dnf");
    expect(packageFamily(os("alpine", [], "3.20"), all)).toBe("apk");
    expect(packageFamily(os("arch"), all)).toBe("pacman");
    expect(packageFamily(os("opensuse-leap", [], "15.6"), all)).toBe("zypper");
    expect(packageFamily(os("sles", [], "15.5"), all)).toBe("zypper");
  });

  test("centos 7 has yum only, and we follow the host", () => {
    expect(packageFamily(os("centos", [], "7.9"), ["yum", "systemctl"])).toBe("yum");
    expect(packageFamily(os("centos", [], "8"), ["dnf", "yum", "systemctl"])).toBe("dnf");
  });

  test("ID_LIKE is the fallback when the id is unknown", () => {
    expect(packageFamily(os("customos", ["debian"]), ["apt-get"])).toBe("apt");
    expect(packageFamily(os("customos", ["rhel", "fedora"]), ["dnf"])).toBe("dnf");
  });

  test("no mapping at all: use whatever manager is actually installed", () => {
    expect(packageFamily(os("weird"), ["apk"])).toBe("apk");
    expect(packageFamily(os("weird"), ["pacman", "zypper"])).toBe("pacman");
  });

  test("nothing installed is unknown, not a guess", () => {
    expect(packageFamily(os("weird"), ["systemctl"])).toBe("unknown");
  });
});

describe("installCommands", () => {
  test("one install path per family", () => {
    expect(installCommands("apt")).toEqual([
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y podman",
    ]);
    expect(installCommands("dnf")).toEqual(["dnf install -y podman"]);
    expect(installCommands("yum")).toEqual(["yum install -y podman"]);
    expect(installCommands("apk")).toEqual(["apk add --no-cache podman"]);
    expect(installCommands("pacman")).toEqual(["pacman -Sy --noconfirm podman"]);
    expect(installCommands("zypper")).toEqual(["zypper --non-interactive install podman"]);
    expect(installCommands("unknown")).toEqual([]);
  });
});

describe("planBootstrap", () => {
  const probe = (over: Partial<BootstrapProbe> = {}): BootstrapProbe => ({
    os: os("ubuntu"),
    family: "apt",
    hasPodman: false,
    hasSystemd: true,
    inContainer: "",
    ...over,
  });

  test("missing podman: install first, then converge the runtime prerequisites", () => {
    const labels = planBootstrap(probe()).map((s) => s.label);
    expect(labels[0]).toBe("install podman (apt)");
    expect(labels).toContain("registry search path");
    expect(labels).toContain("boot-time restart unit");
    expect(labels).toContain("podman version");
    expect(labels).toContain("smoke test (pull + run)");
  });

  test("podman already present: no install step, prerequisites still converge", () => {
    const steps = planBootstrap(probe({ hasPodman: true }));
    expect(steps.some((s) => s.label.startsWith("install podman"))).toBe(false);
    expect(steps.some((s) => s.label === "registry search path")).toBe(true);
  });

  test("no systemd: skip the restart unit, keep everything else", () => {
    const steps = planBootstrap(probe({ hasSystemd: false }));
    expect(steps.some((s) => s.label === "boot-time restart unit")).toBe(false);
    expect(steps.some((s) => s.label === "smoke test (pull + run)")).toBe(true);
  });

  test("smoke can be skipped", () => {
    const steps = planBootstrap(probe(), { smoke: false });
    expect(steps.some((s) => s.label === "smoke test (pull + run)")).toBe(false);
  });

  test("registry config is written once and never clobbered", () => {
    const step = planBootstrap(probe()).find((s) => s.label === "registry search path");
    expect(step?.cmd).toContain("if [ -f /etc/containers/registries.conf.d/999-bundant.conf ]");
    expect(step?.cmd).toContain("already configured");
    expect(step?.cmd).toContain('unqualified-search-registries = ["docker.io"]');
  });

  test("unknown family fails loudly with the manual instruction", () => {
    const step = planBootstrap(probe({ family: "unknown" })).find((s) => s.label === "install podman");
    expect(step?.cmd).toContain("install podman manually");
    expect(step?.cmd).toContain("exit 1");
  });

  test("inside LXC the smoke failure explains nesting=1", () => {
    const step = planBootstrap(probe({ inContainer: "lxc" })).find((s) => s.label === "smoke test (pull + run)");
    expect(step?.cmd).toContain("nesting=1");
  });
});

class FakeExecutor implements Executor {
  readonly kind = "fake";
  readonly calls: string[] = [];
  constructor(private readonly handle: (cmd: string) => ExecResult) {}
  async run(cmd: string): Promise<ExecResult> {
    this.calls.push(cmd);
    return this.handle(cmd);
  }
  async putFile(): Promise<void> {}
  async close(): Promise<void> {}
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

describe("HostBootstrap (behavioral)", () => {
  const ready: BootstrapProbe = {
    os: os("ubuntu", ["debian"], "24.04"),
    family: "apt",
    hasPodman: true,
    hasSystemd: true,
    inContainer: "",
  };

  test("dry run plans everything and touches nothing", async () => {
    const exec = new FakeExecutor(() => ok());
    const logs = await capture(async () => {
      await new HostBootstrap(exec, "box").converge(ready, { dryRun: true });
    });
    expect(exec.calls).toEqual([]);
    expect(logs.filter((l) => l.startsWith("    $ ")).length).toBe(planBootstrap(ready).length);
  });

  test("quiet on success: loud step output dropped, bundant notes and version kept", async () => {
    const exec = new FakeExecutor((cmd) => {
      if (cmd.startsWith("podman --version")) return ok("podman version 5.7.0");
      return ok("Reading package lists...\nbundant: registry search path already configured");
    });
    const logs = await capture(async () => {
      await new HostBootstrap(exec, "box").converge(ready);
    });
    expect(logs.some((l) => l === "    registry search path already configured")).toBe(true);
    expect(logs.some((l) => l === "    podman version 5.7.0")).toBe(true);
    expect(logs.some((l) => l.includes("Reading package lists"))).toBe(false);
  });

  test("a failing step is reported with its output and no ready line", async () => {
    const notReady: BootstrapProbe = { ...ready, hasPodman: false };
    const exec = new FakeExecutor((cmd) =>
      cmd.includes("install -y podman")
        ? { code: 100, stdout: "", stderr: "E: Unable to locate package podman" }
        : ok("bundant: ok"),
    );
    let report: Awaited<ReturnType<HostBootstrap["converge"]>> | undefined;
    const logs = await capture(async () => {
      report = await new HostBootstrap(exec, "box").converge(notReady);
    });
    expect(report?.failures).toEqual(["install podman (apt)"]);
    expect(logs.some((l) => l.includes("Unable to locate package podman"))).toBe(true);
    expect(logs.some((l) => l.includes("failed (exit 100)"))).toBe(true);
  });
});
