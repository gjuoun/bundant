import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The daemon is Go, outside the npm package; these checks keep its shipping
 * contract (static, scratch, stdlib-only, no host toolchain) from regressing.
 */
const dir = join(import.meta.dir, "../../daemon/sessiond");
const read = (name: string): string => readFileSync(join(dir, name), "utf8");

describe("sessiond source contract", () => {
  test("the image is scratch and copies a per-arch binary", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("FROM scratch");
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toContain("sessiond-linux-${TARGETARCH}");
  });

  test("the build is static, trimmed and covers both arches", () => {
    const script = read("build.sh");
    expect(script).toContain("CGO_ENABLED=0");
    expect(script).toContain("-trimpath");
    expect(script).toContain("ldflags=\"-s -w\"");
    expect(script).toContain("for arch in amd64 arm64");
    expect(script).toContain("podman build --platform");
  });

  test("the watcher stays stdlib-only and uses the kernel facts the card names", () => {
    const source = read("main.go");
    expect(source).toContain("SO_PEERCRED");
    expect(source).toContain("sysPidfdOpen = 434");
    expect(source).toContain("cgroup.events");
    expect(source).toContain("500 * time.Millisecond");
    expect(source).toContain("ed25519.Sign");
    expect(source).toContain("session.open");
    expect(source).toContain("session.closed");
    expect(source).not.toContain("google.golang.org");
    expect(read("go.mod")).not.toContain("require");
  });
});
