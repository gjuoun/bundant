/**
 * bundant SDK example: a full deploy lifecycle without a CLI config file.
 *
 *   BUNDANT_E2E_HOST=root@192.168.2.104 BUNDANT_E2E_RUNTIME=docker \
 *   BUNDANT_E2E_PREFIX=sdksmoke BUNDANT_E2E_PROXY_HOST=sdksmoke-docker.test \
 *   bun run examples/sdk-usage/main.ts
 *
 * deploy rev sdk1 -> deploy rev sdk2 -> rollback -> scale 2, reading status
 * through the SDK after every step. Every line it prints is an assertion the
 * smoke script checks, so the example is the test: no fakes, a real host, the
 * same surface users import.
 */
import { bundant, defineDeployment, runSdk, type StatusRow } from "../../src/sdk/mod.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error("set " + name);
  }
  return value;
}

const host = required("BUNDANT_E2E_HOST");
const runtime = required("BUNDANT_E2E_RUNTIME") as "docker" | "podman";
const group = required("BUNDANT_E2E_PREFIX");
const proxyHost = required("BUNDANT_E2E_PROXY_HOST");
const image = process.env.BUNDANT_E2E_IMAGE ?? "docker.io/traefik/whoami:v1.10";

const api = defineDeployment({
  group,
  service: "whoami",
  image,
  hosts: [host],
  runtime,
  port: 80,
  proxy: { host: proxyHost },
  healthcheck: { http: { path: "/", port: 80 } },
});

const layer = { hosts: [host], runtime } as const;
const unit = group + ".whoami.web";

async function live(): Promise<StatusRow> {
  const rows = await runSdk(bundant.status(group + ".**"), layer);
  const row = rows.find((candidate) => candidate.path === unit);
  if (row === undefined) throw new Error("no status row for " + unit);
  return row;
}

const first = await runSdk(bundant.deploy(api, { revision: "sdk1" }), layer);
const afterFirst = await live();
console.log(
  "deployed rev=" + first.revision + " live=" + afterFirst.live + "/" + afterFirst.expected,
);

const second = await runSdk(bundant.deploy(api, { revision: "sdk2" }), layer);
const afterSecond = await live();
console.log(
  "redeployed rev=" + second.revision + " live=" + afterSecond.live + "/" + afterSecond.expected,
);

await runSdk(bundant.rollback(api), layer);
const afterRollback = await live();
console.log(
  "rolled back to " + afterRollback.revision + " live=" + afterRollback.live + "/" +
    afterRollback.expected,
);

await runSdk(bundant.scale(api, { replicas: 2 }), layer);
const afterScale = await live();
console.log("scaled replicas=2 live=" + afterScale.live);
