import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshExecutor, connectOptionsFor } from "../exec/ssh.ts";
import { HostSession, withHostSession, type SessionForward } from "./session.ts";

interface State {
  starts: number;
  closes: number;
  dead?: boolean;
}

function fakeExecutor(state: State): SshExecutor {
  return {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    stream: async () => 0,
    putFile: async () => undefined,
    close: async () => {
      state.closes += 1;
    },
  } as unknown as SshExecutor;
}

function fakeForwards(state: State) {
  return (): SessionForward => ({
    localSocket: "/tmp/fake-" + state.starts + ".sock",
    start: async () => {
      state.starts += 1;
      return "/tmp/fake-" + state.starts + ".sock";
    },
    close: async () => {
      state.closes += 1;
      if (state.dead === true) throw new Error("forward already dead");
    },
  });
}

function sessionFor(state: State): HostSession {
  return new HostSession(
    { host: "box", options: [], sshTarget: "root@box" },
    { forwardDir: "/tmp", forwardFactory: fakeForwards(state), executor: fakeExecutor(state) },
  );
}

describe("HostSession exec reuse", () => {
  test("two exec calls share one control master and dispose leaves no socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundant-ssh-"));
    let handshakes = 0;
    const runner = async (argv: string[]) => {
      if (!argv.includes("-O")) {
        const control = argv.find((arg) => arg.startsWith("ControlPath="));
        if (control !== undefined) {
          const path = control.slice("ControlPath=".length);
          if (!existsSync(path)) {
            writeFileSync(path, "");
            handshakes += 1;
          }
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const connection = { host: "box", user: "root", options: [], sshTarget: "root@box" };
    const executor = new SshExecutor(
      { ...connectOptionsFor(connection), controlDir: dir, controlPersistSec: 60 },
      runner,
    );
    const session = new HostSession(connection, {
      forwardDir: "/tmp",
      forwardFactory: fakeForwards({ starts: 0, closes: 0 }),
      executor,
    });
    await session.exec("true");
    await session.exec("true");
    expect(handshakes).toBe(1);
    await session.dispose();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("HostSession", () => {
  test("dispose closes every forward it created", async () => {
    const state: State = { starts: 0, closes: 0 };
    const session = sessionFor(state);
    await session.forwardSocket("/var/run/docker.sock");
    await session.forwardSocket("/run/podman/podman.sock");
    expect(state.starts).toBe(2);
    await session.dispose();
    expect(state.closes).toBe(3); // two forwards + the executor
  });

  test("dispose is idempotent", async () => {
    const state: State = { starts: 0, closes: 0 };
    const session = sessionFor(state);
    await session.forwardSocket("/var/run/docker.sock");
    await session.dispose();
    const afterFirst = state.closes;
    await session.dispose();
    await session.dispose();
    expect(state.closes).toBe(afterFirst);
  });

  test("a dead forward is not an error", async () => {
    const state: State = { starts: 0, closes: 0, dead: true };
    const session = sessionFor(state);
    await session.forwardSocket("/var/run/docker.sock");
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(state.closes).toBeGreaterThanOrEqual(1);
  });

  test("withHostSession disposes on success and on throw", async () => {
    const okState: State = { starts: 0, closes: 0 };
    const value = await withHostSession(
      { host: "box", options: [], sshTarget: "root@box" },
      async (session) => {
        await session.forwardSocket("/var/run/docker.sock");
        return 42;
      },
      { forwardDir: "/tmp", forwardFactory: fakeForwards(okState), executor: fakeExecutor(okState) },
    );
    expect(value).toBe(42);
    expect(okState.closes).toBe(2);

    const throwState: State = { starts: 0, closes: 0 };
    await expect(
      withHostSession(
        { host: "box", options: [], sshTarget: "root@box" },
        async (session) => {
          await session.forwardSocket("/var/run/docker.sock");
          throw new Error("boom");
        },
        {
          forwardDir: "/tmp",
          forwardFactory: fakeForwards(throwState),
          executor: fakeExecutor(throwState),
        },
      ),
    ).rejects.toThrow("boom");
    expect(throwState.closes).toBe(2);
  });
});
