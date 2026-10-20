import { describe, expect, test } from "bun:test";
import type { BundantConfig } from "../config.ts";
import type { NameGrammar, NameIdentity } from "../config/grammar.ts";
import { v2Grammar } from "../config/v2/grammar.ts";
import { ServiceIdentity } from "./identity.ts";

function cfg(over: Partial<BundantConfig> = {}): BundantConfig {
  return {
    version: 2,
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
    expect(ServiceIdentity.from(cfg(), v2Grammar, "r1").containerName()).toBe("default.api.web.r1");
    expect(ServiceIdentity.from(cfg({ group: "shop" }), v2Grammar, "r1").containerName()).toBe(
      "shop.api.web.r1",
    );
    expect(
      ServiceIdentity.from(cfg({ group: "shop", kind: "accessory" }), v2Grammar, "r1").containerName(),
    ).toBe("shop.api");
    expect(
      ServiceIdentity.from(cfg({ group: "default", kind: "accessory" }), v2Grammar, "r1").containerName(),
    ).toBe("default.api");
  });

  test("camelCase, snake_case and uppercase identifiers compose dotted names", () => {
    const service = ServiceIdentity.from(
      cfg({ group: "Shop", service: "api", role: "Web" }),
      v2Grammar,
      "r2026a",
    );
    expect(service.containerName()).toBe("Shop.api.Web.r2026a");
    expect(service.containerName(2)).toBe("Shop.api.Web.r2026a.2");
    expect(service.proxyId()).toBe("Shop.api.Web");

    const parsed = ServiceIdentity.parse("Shop.api.Web.r2026a.2", v2Grammar);
    expect(parsed?.containerName()).toBe("Shop.api.Web.r2026a.2");
    const accessoryParsed = ServiceIdentity.parse("Shop.db", v2Grammar);
    expect(accessoryParsed?.kind).toBe("accessory");
    expect(accessoryParsed?.containerName()).toBe("Shop.db");
  });

  test("replica suffixes appear only when requested", () => {
    const identity = ServiceIdentity.from(cfg({ replicas: 3 }), v2Grammar, "r1");
    expect(identity.containerName(2)).toBe("default.api.web.r1.2");
    expect(identity.containerName(3)).toBe("default.api.web.r1.3");
    expect(identity.containerName()).toBe("default.api.web.r1");
  });

  test("proxy id, env path and lock key", () => {
    const ungrouped = ServiceIdentity.from(cfg({ group: "default" }), v2Grammar, "r1");
    expect(ungrouped.proxyId()).toBe("default.api.web");
    expect(ungrouped.envPath()).toBe("~/.bundant/env/default/api-web.env");
    expect(ungrouped.lockKey()).toBe("default/api");

    const grouped = ServiceIdentity.from(cfg({ group: "shop" }), v2Grammar, "r1");
    expect(grouped.proxyId()).toBe("shop.api.web");
    expect(grouped.envPath()).toBe("~/.bundant/env/shop/api-web.env");
    expect(grouped.lockKey()).toBe("shop/api");
  });

  test("labels carry service/group/kind and revision/replica", () => {
    const labels = ServiceIdentity.from(cfg({ group: "shop" }), v2Grammar, "r1").labels({}, 2);
    expect(labels).toEqual({
      "bundant.service": "api",
      "bundant.group": "shop",
      "bundant.kind": "service",
      "bundant.revision": "r1",
      "bundant.replica": "2",
    });
  });

  test("withRevision keeps every other field", () => {
    const before = ServiceIdentity.from(cfg({ group: "shop", replicas: 2 }), v2Grammar, "r1");
    const after = before.withRevision("r2");
    expect(after.compose()).toBe("shop.api.web.r2");
    expect(after.proxyId()).toBe(before.proxyId());
    expect(after.envPath()).toBe(before.envPath());
    expect(after.lockKey()).toBe(before.lockKey());
  });
});

describe("parse(compose(x)) === x", () => {
  const table: Array<{ name: string; group: string; service: string; role: string; revision: string }> = [
    { name: "ungrouped", group: "default", service: "api", role: "web", revision: "r1" },
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
        v2Grammar,
        entry.revision,
      );
      const parsed = ServiceIdentity.parse(identity.compose(), v2Grammar, entry.group);
      expect(parsed).toBeDefined();
      expect(parsed!.group).toBe(entry.group);
      expect(parsed!.service).toBe(entry.service);
      expect(parsed!.role).toBe(entry.role);
      expect(parsed!.revision).toBe(entry.revision);
    });
  }

  test("an unambiguous composed name parses without a group hint", () => {
    const parsed = ServiceIdentity.parse("shop.api.web.r1", v2Grammar);
    expect(parsed?.group).toBe("shop");
    expect(parsed?.service).toBe("api");
    expect(parsed?.revision).toBe("r1");
  });

  test("an invalid composed name is rejected", () => {
    expect(ServiceIdentity.parse("Bad-Name-Web-r1", v2Grammar)).toBeUndefined();
    expect(ServiceIdentity.parse("onlytwo", v2Grammar)).toBeUndefined();
  });

  test("the grammar comes from the version module, not a constant", () => {
    const dottedGrammar: NameGrammar = v2Grammar;
    const identity = ServiceIdentity.from(cfg({ group: "shop" }), dottedGrammar, "r1");
    expect(identity.containerName()).toBe("shop.api.web.r1");
    expect(v2Grammar.compose({ group: "shop", service: "api", role: "web", revision: "r1" })).toBe(
      identity.containerName(),
    );
  });
});
