import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HostConnection } from "../hosts.ts";
import { SshForwardPool, SshSocketForward, buildForwardArgs } from "./transport.ts";

const CONN: HostConnection = {
  user: "root",
  host: "192.0.2.10",
  port: 2222,
  options: [],
  sshTarget: "root@192.0.2.10",
};

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, "SIGTERM");
    return true;
  }
}

function fakeSpawn(calls: string[][]): (argv: readonly string[]) => ChildProcess {
  return (argv) => {
    calls.push([...argv]);
    const local = argv[argv.indexOf("-L") + 1]?.split(":")[0];
    setTimeout(() => {
      if (local !== undefined) void writeFile(local, "");
    }, 5);
    return new FakeChild() as unknown as ChildProcess;
  };
}

describe("ssh streamlocal forwarding", () => {
  test("argv is ssh -N -L local:remote with ExitOnForwardFailure and the target last", () => {
    const argv = buildForwardArgs(CONN, "/tmp/local.sock", "/var/run/docker.sock");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-N");
    expect(argv[argv.indexOf("-L") + 1]).toBe("/tmp/local.sock:/var/run/docker.sock");
    expect(argv[argv.indexOf("ExitOnForwardFailure=yes") - 1]).toBe("-o");
    expect(argv).toContain("-p");
    expect(argv[argv.length - 1]).toBe("root@192.0.2.10");
  });

  test("start waits for the local socket, close kills the child and unlinks it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bundant-fwd-"));
    const calls: string[][] = [];
    const forward = new SshSocketForward({
      connection: CONN,
      remoteSocket: "/var/run/docker.sock",
      localDir: dir,
      spawnProcess: fakeSpawn(calls),
    });
    expect(await forward.start()).toBe(forward.localSocket);
    expect(calls[0]?.[calls[0].indexOf("-L") + 1]).toBe(forward.localSocket + ":/var/run/docker.sock");
    expect((await readdir(dir)).length).toBe(1);
    await forward.close();
    expect(await readdir(dir)).toEqual([]);
  });

  test("pool reuses one forward per host+socket and closes all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bundant-pool-"));
    const calls: string[][] = [];
    const pool = new SshForwardPool(fakeSpawn(calls));
    const forward = await pool.acquire({ connection: CONN, remoteSocket: "/run/podman/podman.sock", localDir: dir });
    const again = await pool.acquire({
      connection: CONN,
      remoteSocket: "/run/podman/podman.sock",
      localDir: dir,
    });
    expect(again).toBe(forward);
    await pool.closeAll();
    expect(await readdir(dir)).toEqual([]);
  });
});
