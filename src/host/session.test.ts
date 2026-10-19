import { describe, expect, test } from "bun:test";
import type { SshExecutor } from "../exec/ssh.ts";
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
