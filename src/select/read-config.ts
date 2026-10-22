import type { BundantConfig, LoadedConfig } from "../config/types.ts";
import type { RuntimeKind } from "../runtime.ts";

/**
 * The LoadedConfig read verbs need when they have no spec: no image, no proxy,
 * just the hosts and engine to look at. Selectors carry the identity.
 */
export function readConfig(hosts: readonly string[], runtime: RuntimeKind = "docker"): LoadedConfig {
  const config: BundantConfig = {
    version: 2,
    service: "*",
    image: "",
    role: "web",
    replicas: 1,
    kind: "service",
    hosts: [...hosts],
    runtime,
    env: { vars: {} },
    healthcheck: { path: "/", port: 80, timeout: 30 },
    proxy: { enabled: false, port: 80, tls: false, image: "" },
  };
  return { config, envContent: null, envCount: 0, path: "", version: 2 };
}
