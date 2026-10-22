import { describe, expect, it } from "bun:test";
import { ConfigError } from "../config/errors.ts";
import { defineAccessory, defineDeployment, defineGroup } from "./spec.ts";

const HOSTS = ["root@docker01"];

describe("defineDeployment", () => {
  it("composes the dotted path and fills port defaults", () => {
    const api = defineDeployment({
      group: "shop",
      service: "api",
      image: "traefik/whoami:v1.10",
      hosts: HOSTS,
      port: 3000,
      proxy: { host: "api.shop.test" },
      env: { A: "1", B: "2" },
      healthcheck: { http: { path: "/up" } },
    });

    expect(api.kind).toBe("service");
    expect(api.path).toBe("shop.api.web");
    expect(api.name).toBe("api");
    expect(api.loaded.config.group).toBe("shop");
    expect(api.loaded.config.proxy.port).toBe(3000);
    expect(api.loaded.config.proxy.enabled).toBe(true);
    expect(api.loaded.config.healthcheck.port).toBe(3000);
    expect(api.loaded.config.healthcheck.path).toBe("/up");
    expect(api.loaded.envContent).toBe("A=1\nB=2\n");
    expect(api.loaded.envCount).toBe(2);
    expect(api.loaded.version).toBe(2);
  });

  it("omitting the proxy block means no proxy", () => {
    const worker = defineDeployment({
      service: "worker",
      image: "img",
      hosts: HOSTS,
    });
    expect(worker.path).toBe("default.worker.web");
    expect(worker.loaded.config.proxy.enabled).toBe(false);
    expect(worker.loaded.envContent).toBeNull();
  });

  it("rejects replicas > 1 without a proxy", () => {
    expect(() =>
      defineDeployment({ service: "api", image: "img", hosts: HOSTS, replicas: 2 }),
    ).toThrow(ConfigError);
  });

  it("rejects an invalid identifier with the field message", () => {
    expect(() =>
      defineDeployment({ service: "api.v2", image: "img", hosts: HOSTS }),
    ).toThrow(/service "api\.v2"/);
  });

  it("rejects an undefined env value instead of dropping it", () => {
    expect(() =>
      defineDeployment({
        service: "api",
        image: "img",
        hosts: HOSTS,
        env: { DATABASE_URL: undefined },
      }),
    ).toThrow(/env DATABASE_URL is undefined/);
  });

  it("rejects empty hosts when BUNDANT_HOSTS is unset", () => {
    const previous = process.env.BUNDANT_HOSTS;
    delete process.env.BUNDANT_HOSTS;
    try {
      expect(() => defineDeployment({ service: "api", image: "img" })).toThrow(/hosts is empty/);
    } finally {
      if (previous !== undefined) process.env.BUNDANT_HOSTS = previous;
    }
  });
});

describe("defineAccessory", () => {
  it("takes a name and a volume map", () => {
    const db = defineAccessory({
      group: "shop",
      name: "db",
      image: "docker.io/library/postgres:17",
      hosts: HOSTS,
      env: { POSTGRES_PASSWORD: "secret" },
      volumes: { pgdata: "/var/lib/postgresql/data" },
      healthcheck: { tcp: 5432 },
    });

    expect(db.kind).toBe("accessory");
    expect(db.path).toBe("shop.db");
    expect(db.loaded.config.kind).toBe("accessory");
    expect(db.loaded.config.volumes).toEqual(["pgdata:/var/lib/postgresql/data"]);
    expect(db.loaded.config.healthcheck.tcp).toBe(5432);
    expect(db.loaded.config.proxy.enabled).toBe(false);
  });

  it("rejects replicas on an accessory", () => {
    expect(() =>
      defineAccessory({
        name: "db",
        image: "img",
        hosts: HOSTS,
        replicas: 2,
      } as Parameters<typeof defineAccessory>[0]),
    ).toThrow(/replicas is not allowed/);
  });
});

describe("defineGroup", () => {
  const db = defineAccessory({ group: "shop", name: "db", image: "img", hosts: HOSTS });
  const api = defineDeployment({
    group: "shop",
    service: "api",
    image: "img",
    hosts: HOSTS,
    proxy: { host: "api.shop.test" },
  });

  it("keys members by name and orders dependencies first", () => {
    const shop = defineGroup({ members: [api, db], needs: { api: ["db"] } });
    expect(shop.kind).toBe("group");
    expect(shop.group).toBe("shop");
    expect(Object.keys(shop.members)).toEqual(["api", "db"]);
    expect(shop.members.api!.path).toBe("shop.api.web");
    expect(shop.order).toEqual(["db", "api"]);
  });

  it("rejects duplicate members, unknown needs, self-needs and cycles", () => {
    expect(() => defineGroup({ members: [db, db] })).toThrow(/duplicate member/);
    expect(() => defineGroup({ members: [db], needs: { api: ["db"] } })).toThrow(/needs names unknown member/);
    expect(() => defineGroup({ members: [db], needs: { db: ["db"] } })).toThrow(/cannot need itself/);
    expect(() =>
      defineGroup({ members: [api, db], needs: { api: ["db"], db: ["api"] } }),
    ).toThrow(/cycle/);
  });

  it("rejects members from different groups", () => {
    const other = defineDeployment({ group: "other", service: "web", image: "img", hosts: HOSTS });
    expect(() => defineGroup({ members: [api, other] })).toThrow(/belongs to group/);
  });
});
