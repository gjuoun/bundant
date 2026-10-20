import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "./local.ts";
import { buildSshArgs, controlPath } from "./ssh.ts";

describe("buildSshArgs", () => {
  test("multiplexing and safety options are always present", () => {
    const args = buildSshArgs({ target: "box.ts.net" });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPath=" + controlPath({ target: "box.ts.net" }));
    expect(args).toContain("ControlPersist=60");
  });

  test("an explicit login user rides through the ssh argv", () => {
    const args = buildSshArgs({ target: "root@10.0.0.5" }, "true");
    expect(args).toContain("root@10.0.0.5");
    expect(args[args.length - 2]).toBe("root@10.0.0.5");
  });

  test("command rides as one final argv element (remote shell parses it)", () => {
    const args = buildSshArgs({ target: "box.ts.net" }, 'docker run --rm x -w "%{http_code}"');
    expect(args[args.length - 1]).toBe('docker run --rm x -w "%{http_code}"');
    expect(args.indexOf("box.ts.net")).toBe(args.length - 2);
  });
});

describe("LocalExecutor", () => {
  test("runs a command and reports code/stdout/stderr", async () => {
    const ex = new LocalExecutor();
    const ok = await ex.run("echo hi");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("hi\n");
    const bad = await ex.run("echo oops >&2; exit 3");
    expect(bad.code).toBe(3);
    expect(bad.stderr).toBe("oops\n");
  });

  test("putFile writes content and applies mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-put-"));
    const src = join(dir, "src.env");
    writeFileSync(src, "A=1\n");
    const ex = new LocalExecutor();
    await ex.putFile(src, dir + "/dest.env", "600");
    expect(readFileSync(dir + "/dest.env", "utf8")).toBe("A=1\n");
    const mode = (statSync(dir + "/dest.env").mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});
