export type CommandWithFlags = {
  flags: { flag: string }[];
};

/**
 * Every command page repeats the shared flags, so summing the pages double-counts.
 * The page must show how many distinct flags exist across the whole CLI.
 */
export function commandStats(commands: CommandWithFlags[]) {
  const flags = new Set(commands.flatMap((command) => command.flags.map((flag) => flag.flag)));
  return { commands: commands.length, flags: flags.size };
}
