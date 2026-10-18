import { describe, expect, test } from "bun:test";
import { connectionForTarget, hostTargets, parseHost, resolveConnections } from "./hosts.ts";

describe("parseHost", () => {
  test("bare hostname, IPv4 and IPv6 forms", () => {
    expect(parseHost("box.example.com")).toEqual({
      user: undefined,
      host: "box.example.com",
      port: undefined,
    });
    expect(parseHost("10.0.0.5")).toEqual({ user: undefined, host: "10.0.0.5", port: undefined });
    expect(parseHost("[2001:db8::1]")).toEqual({
      user: undefined,
      host: "2001:db8::1",
      port: undefined,
    });
    expect(parseHost("fe80::1")).toEqual({ user: undefined, host: "fe80::1", port: undefined });
  });

  test("user@host, including IPs and bracketed IPv6", () => {
    expect(parseHost("root@box.example.com").user).toBe("root");
    expect(parseHost("admin@10.0.0.5")).toEqual({
      user: "admin",
      host: "10.0.0.5",
      port: undefined,
    });
    expect(parseHost("root@[2001:db8::1]")).toEqual({
      user: "root",
      host: "2001:db8::1",
      port: undefined,
    });
  });

  test("explicit ports in every shape", () => {
    expect(parseHost("box.example.com:2222")).toEqual({
      user: undefined,
      host: "box.example.com",
      port: 2222,
    });
    expect(parseHost("root@box.example.com:2222")).toEqual({
      user: "root",
      host: "box.example.com",
      port: 2222,
    });
    expect(parseHost("root@[2001:db8::1]:2200")).toEqual({
      user: "root",
      host: "2001:db8::1",
      port: 2200,
    });
    expect(() => parseHost("box.example.com:0")).toThrow(/invalid port/);
    expect(() => parseHost("box.example.com:99999")).toThrow(/invalid port/);
  });

  test("trims and rejects malformed entries", () => {
    expect(parseHost("  root@box  ").host).toBe("box");
    expect(() => parseHost("")).toThrow(/empty host/);
    expect(() => parseHost("@box")).toThrow(/malformed/);
    expect(() => parseHost("root@")).toThrow(/malformed/);
    expect(() => parseHost("root!@box")).toThrow(/invalid ssh user/);
    expect(() => parseHost("[2001:db8::1")).toThrow(/unterminated/);
    expect(() => parseHost("[]")).toThrow(/empty IPv6/);
  });
});

describe("resolveConnections precedence", () => {
  test("per-host user@ beats ssh.user, which beats the ssh config default", () => {
    const resolved = resolveConnections({
      ssh: { user: "deploy" },
      hosts: ["root@a.example.com", "b.example.com", "admin@10.0.0.5", "[2001:db8::1]"],
    });
    expect(resolved.map((c) => c.sshTarget)).toEqual([
      "root@a.example.com",
      "deploy@b.example.com",
      "admin@10.0.0.5",
      "deploy@2001:db8::1",
    ]);
  });

  test("per-host port beats ssh.port", () => {
    const resolved = resolveConnections({
      ssh: { port: 22 },
      hosts: ["a.example.com", "b.example.com:2222"],
    });
    expect(resolved.map((c) => c.port)).toEqual([22, 2222]);
  });

  test("identity is expanded and options ride along", () => {
    const [conn] = resolveConnections({
      ssh: { identity: "~/.ssh/prod", options: ["-o", "StrictHostKeyChecking=accept-new"] },
      hosts: ["box.example.com"],
    });
    expect(conn!.identity!.startsWith("/")).toBe(true);
    expect(conn!.identity!.endsWith("/.ssh/prod")).toBe(true);
    expect(conn!.options).toEqual(["-o", "StrictHostKeyChecking=accept-new"]);
  });

  test("without an ssh block, hosts stay bare and defer to ssh defaults", () => {
    expect(hostTargets({ hosts: ["a.example.com", "deploy@b.example.com"] })).toEqual([
      "a.example.com",
      "deploy@b.example.com",
    ]);
    const [conn] = resolveConnections({ hosts: ["a.example.com"] });
    expect(conn!.port).toBeUndefined();
    expect(conn!.identity).toBeUndefined();
    expect(conn!.options).toEqual([]);
  });

  test("connectionForTarget resolves a plan host back to its connection", () => {
    const config = {
      ssh: { user: "root", port: 2222, identity: "/keys/prod" },
      hosts: ["box.example.com"],
    };
    const conn = connectionForTarget(config, "root@box.example.com");
    expect(conn.port).toBe(2222);
    expect(conn.identity).toBe("/keys/prod");
  });

  test("an unknown target still yields a usable fallback connection", () => {
    const conn = connectionForTarget({ hosts: ["a"] }, "someone@elsewhere");
    expect(conn.sshTarget).toBe("someone@elsewhere");
    expect(conn.options).toEqual([]);
  });
});
