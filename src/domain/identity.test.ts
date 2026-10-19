import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "../config.ts";
import { v1Grammar, type NameGrammar, type NameIdentity } from "../config/v1/grammar.ts";
import { ServiceIdentity } from "./identity.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    service: "api",
    image: "x:1",
    role: "web",
    replicas: 1,
    kind: "service",
    group: "default",
    hosts: ["box.test"],
    runtime: "docker",
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: true, host: "x.test", port: 80, tls: false, image: "p" },
    ...over,
  };
}

describe("ServiceIdentity names", () => {
  test("ungrouped, grouped and accessory names", () => {
    expect(ServiceIdentity.from(cfg(), v1Grammar, "r1").containerName()).toBe("api-web-r1");
    expect(ServiceIdentity.from(cfg({ group: "shop" }), v1Grammar, "r1").containerName()).toBe(
      "shop-api-web-r1",
    );
    expect(
      ServiceIdentity.from(cfg({ group: "shop", kind: "accessory" }), v1Grammar, "r1").containerName(),
    ).toBe("shop-api");
    expect(
      ServiceIdentity.from(cfg({ group: "default", kind: "accessory" }), v1Grammar, "r1").containerName(),
    ).toBe("api");
  });

  test("replica suffixes appear only when requested", () => {
    const identity = ServiceIdentity.from(cfg({ replicas: 3 }), v1Grammar, "r1");
    expect(identity.containerName(2)).toBe("api-web-r1-2");
    expect(identity.containerName(3)).toBe("api-web-r1-3");
    expect(identity.containerName()).toBe("api-web-r1");
  });

  test("proxy id, env path and lock key", () => {
    const ungrouped = ServiceIdentity.from(cfg({ group: "default" }), v1Grammar, "r1");
    expect(ungrouped.proxyId()).toBe("api-web");
    expect(ungrouped.envPath()).toBe("~/.bundant/env/default/api-web.env");
    expect(ungrouped.lockKey()).toBe("default/api");

    const grouped = ServiceIdentity.from(cfg({ group: "shop" }), v1Grammar, "r1");
    expect(grouped.proxyId()).toBe("shop-api-web");
    expect(grouped.envPath()).toBe("~/.bundant/env/shop/api-web.env");
    expect(grouped.lockKey()).toBe("shop/api");
  });

  test("labels carry service/group/kind and revision/replica", () => {
    const labels = ServiceIdentity.from(cfg({ group: "shop" }), v1Grammar, "r1").labels({}, 2);
    expect(labels).toEqual({
      "bundant.service": "api",
      "bundant.group": "shop",
      "bundant.kind": "service",
      "bundant.revision": "r1",
      "bundant.replica": "2",
    });
  });

  test("withRevision keeps every other field", () => {
    const before = ServiceIdentity.from(cfg({ group: "shop", replicas: 2 }), v1Grammar, "r1");
    const after = before.withRevision("r2");
    expect(after.compose()).toBe("shop-api-web-r2");
    expect(after.proxyId()).toBe(before.proxyId());
    expect(after.envPath()).toBe(before.envPath());
    expect(after.lockKey()).toBe(before.lockKey());
  });
});

describe("parse(compose(x)) === x", () => {
  const table: Array<{ name: string; group: string; service: string; role: string; revision: string }> = [
    { name: "ungrouped", group: "", service: "api", role: "web", revision: "r1" },
    { name: "grouped", group: "shop", service: "api", role: "web", revision: "r1" },
    { name: "grouped service", group: "shop", service: "my-service", role: "web", revision: "r9x2k" },
  ];

  for (const entry of table) {
    test(entry.name, () => {
      const identity = ServiceIdentity.from(
        cfg({
          group: entry.group,
          service: entry.service,
          role: entry.role,
        }),
        v1Grammar,
        entry.revision,
      );
      const parsed = ServiceIdentity.parse(identity.compose(), v1Grammar, entry.group);
      expect(parsed).toBeDefined();
      expect(parsed!.group).toBe(entry.group);
      expect(parsed!.service).toBe(entry.service);
      expect(parsed!.role).toBe(entry.role);
      expect(parsed!.revision).toBe(entry.revision);
    });
  }

  test("an unambigous composed name parses without a group hint", () => {
    const parsed = ServiceIdentity.parse("shop-api-web-r1", v1Grammar);
    expect(parsed?.group).toBe("shop");
    expect(parsed?.service).toBe("api");
    expect(parsed?.revision).toBe("r1");
  });

  test("an invalid composed name is rejected", () => {
    expect(ServiceIdentity.parse("Bad-Name-Web-r1", v1Grammar)).toBeUndefined();
    expect(ServiceIdentity.parse("onlytwo", v1Grammar)).toBeUndefined();
  });

  test("the grammar comes from the version module, not a constant", () => {
    const dotGrammar: NameGrammar = {
      ...v1Grammar,
      compose: (identity: NameIdentity) =>
        (identity.group !== undefined && identity.group !== "" && identity.group !== "default"
          ? identity.group + "."
          : "") +
        identity.service + "." + identity.role + "." + identity.revision +
        (identity.replica === undefined ? "" : "." + identity.replica),
      parse: (name: string) => {
        const [group, service, role, revision, replica] = name.split(".");
        if (!service || !role || !revision) throw new Error("bad dot name");
        return {
          group: group === service ? undefined : group,
          service: group === service ? group : service!,
          role: role!,
          revision: revision!,
          replica: replica === undefined ? undefined : Number(replica),
        } as NameIdentity;
      },
    };
    const v1 = ServiceIdentity.from(cfg({ group: "shop" }), v1Grammar, "r1");
    const v2 = ServiceIdentity.from(cfg({ group: "shop" }), dotGrammar, "r1");
    expect(v1.containerName()).toBe("shop-api-web-r1");
    expect(v2.containerName()).toBe("shop.api.web.r1");
    expect(v1.containerName()).not.toBe(v2.containerName());
  });
});
