import { describe, expect, test } from "bun:test";
import { hostTargets, parseHost, resolveHosts } from "./hosts.ts";

describe("parseHost", () => {
  test("bare hostname, IPv4 and IPv6 forms", () => {
    expect(parseHost("box.example.com")).toEqual({
      user: undefined,
      host: "box.example.com",
      sshTarget: "box.example.com",
    });
    expect(parseHost("10.0.0.5")).toEqual({ user: undefined, host: "10.0.0.5", sshTarget: "10.0.0.5" });
    expect(parseHost("[2001:db8::1]")).toEqual({
      user: undefined,
      host: "2001:db8::1",
      sshTarget: "2001:db8::1",
    });
    expect(parseHost("fe80::1")).toEqual({ user: undefined, host: "fe80::1", sshTarget: "fe80::1" });
  });

  test("user@host, including IPs and bracketed IPv6", () => {
    expect(parseHost("root@box.example.com").sshTarget).toBe("root@box.example.com");
    expect(parseHost("root@box.example.com").user).toBe("root");
    expect(parseHost("admin@10.0.0.5").sshTarget).toBe("admin@10.0.0.5");
    expect(parseHost("root@[2001:db8::1]")).toEqual({
      user: "root",
      host: "2001:db8::1",
      sshTarget: "root@2001:db8::1",
    });
  });

  test("trims and rejects malformed entries", () => {
    expect(parseHost("  root@box  ").sshTarget).toBe("root@box");
    expect(() => parseHost("")).toThrow(/empty host/);
    expect(() => parseHost("@box")).toThrow(/malformed/);
    expect(() => parseHost("root@")).toThrow(/malformed/);
    expect(() => parseHost("root!@box")).toThrow(/invalid ssh user/);
    expect(() => parseHost("[2001:db8::1")).toThrow(/unterminated/);
    expect(() => parseHost("[]")).toThrow(/empty IPv6/);
  });

  test("ports are rejected with a pointer to ssh config", () => {
    expect(() => parseHost("box.example.com:2222")).toThrow(/ports are not supported/);
    expect(() => parseHost("[2001:db8::1]:2222")).toThrow(/ports are not supported/);
  });
});

describe("resolveHosts precedence", () => {
  test("per-host user beats the top-level user, which beats ssh default", () => {
    const resolved = resolveHosts({
      user: "root",
      hosts: ["root@a.example.com", "b.example.com", "admin@10.0.0.5", "[2001:db8::1]"],
    });
    expect(resolved.map((h) => h.sshTarget)).toEqual([
      "root@a.example.com",
      "root@b.example.com",
      "admin@10.0.0.5",
      "root@2001:db8::1",
    ]);
  });

  test("without a top-level user, bare hosts stay bare", () => {
    expect(hostTargets({ hosts: ["a.example.com", "deploy@b.example.com"] })).toEqual([
      "a.example.com",
      "deploy@b.example.com",
    ]);
  });

  test("an empty top-level user is treated as unset", () => {
    expect(hostTargets({ user: "", hosts: ["a.example.com"] })).toEqual(["a.example.com"]);
  });
});
