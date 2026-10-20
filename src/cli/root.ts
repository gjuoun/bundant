import { Command } from "effect/cli";
import { globalFlags } from "./options.ts";

/** Root command; every historical global flag is shared with its subcommands. */
export const rootCommand = Command.make("bundant").pipe(
  Command.withDescription(
    "Zero-downtime single-host deploys over SSH — docker/podman + kamal-proxy",
  ),
  Command.withSharedFlags(globalFlags),
);
