export type Command = {
  name: string;
  usage: string;
  description: string;
};

export type CommandGroup = {
  id: string;
  label: string;
  blurb: string;
  commands: Command[];
};

/** Every entry exists in `bundant --help` / the subcommand helps for 0.1.0. */
export const commandGroups: CommandGroup[] = [
  {
    id: 'deploy',
    label: 'Deploy',
    blurb: 'Ship, move traffic and keep a rollback path.',
    commands: [
      {
        name: 'deploy',
        usage: 'bundant deploy [-f deploy.yml] [--dry-run]',
        description: 'The full pipeline: pull or stream the image, start the new revision, health-gate it, swap the proxy, stop the old one.',
      },
      {
        name: 'scale',
        usage: 'bundant scale --replicas 3 [-f deploy.yml]',
        description: 'Add or remove replicas of the running revision. Proxy targets change before containers are drained.',
      },
      {
        name: 'rollback',
        usage: 'bundant rollback [--to-revision <rev>]',
        description: 'Re-gate the previous revision, or the exact one named by --to-revision, then swap it back.',
      },
      {
        name: 'history',
        usage: 'bundant history [-f deploy.yml]',
        description: 'Revisions newest-first with state and the current one marked.',
      },
      {
        name: 'prune',
        usage: 'bundant prune [--keep 3]',
        description: 'Drop stopped revisions beyond the newest K (default 3) and their dangling layers.',
      },
      {
        name: 'delete',
        usage: 'bundant delete [--yes] [--images]',
        description: 'Remove the service everywhere: proxy route, containers, rendered env file. Refuses without --yes.',
      },
    ],
  },
  {
    id: 'units',
    label: 'Units',
    blurb: 'Operate one service, accessory or a glob of paths.',
    commands: [
      {
        name: 'validate',
        usage: 'bundant validate [-f deploy.yml] [--json]',
        description: 'Parse one deploy, accessory or group file and print the resolved identity plus the full error list. Never contacts a host.',
      },
      {
        name: 'status',
        usage: 'bundant status [path] [--json]',
        description: 'Unit status: path, kind, revision, expected/live counts and containers. No path means every unit.',
      },
      {
        name: 'start',
        usage: 'bundant start <path>',
        description: 'Start a unit, or create an accessory from -f. A glob path such as shop.** targets a group.',
      },
      {
        name: 'stop',
        usage: 'bundant stop <path>',
        description: 'Stop every replica matched by the path.',
      },
      {
        name: 'restart',
        usage: 'bundant restart <path>',
        description: 'Restart a unit. An accessory is recreated; a service is stopped and started through the proxy.',
      },
      {
        name: 'rm',
        usage: 'bundant rm <path> [--yes] [--volumes]',
        description: 'Remove matched units. Prints the resolved set first; accessories keep volumes unless --volumes.',
      },
      {
        name: 'logs',
        usage: 'bundant logs [path] [--tail 100] [--follow]',
        description: 'Tail logs for matched units, each line prefixed with its replica. --follow streams.',
      },
      {
        name: 'exec',
        usage: 'bundant exec [path] -- <cmd...>',
        description: 'Exec in the first running replica, or every replica with --all.',
      },
      {
        name: 'inspect',
        usage: 'bundant inspect [path]',
        description: 'State, restarts, health, image and restart policy of the first matched replica.',
      },
    ],
  },
  {
    id: 'groups',
    label: 'Groups',
    blurb: 'Namespaces, stateful members and host prerequisites.',
    commands: [
      {
        name: 'group',
        usage: 'bundant group <install|uninstall|status|rollback> -f group.yml',
        description: 'Ordered install with needs:, a labelled-sweep uninstall, aggregated status, or a whole-group rollback to one shared sha.',
      },
      {
        name: 'accessory',
        usage: 'bundant accessory <boot|reboot|stop|logs|status|remove> -f accessory.yml',
        description: 'Lifecycle for a stateful member: stable name, named volumes and healthcheck.tcp readiness.',
      },
      {
        name: 'bootstrap',
        usage: 'bundant bootstrap [--dry-run] [--skip-smoke]',
        description: 'Install podman when missing, enable podman-restart.service, set the registry search path and smoke-test a container.',
      },
    ],
  },
  {
    id: 'ops',
    label: 'Ops',
    blurb: 'Read-only monitoring, straight over the same ssh connection.',
    commands: [
      {
        name: 'runtime',
        usage: 'bundant runtime [--json] [--hosts a,b]',
        description: 'Per-host engine detection: engine, API version, socket path, forward path and socket-service state.',
      },
      {
        name: 'ui',
        usage: 'bundant ui [--port 8787]',
        description: 'Local read-only monitoring page bound to 127.0.0.1. Pull-on-demand; nothing is installed on the host.',
      },
      {
        name: 'ps',
        usage: 'bundant ps [-f deploy.yml]',
        description: 'Every container on every host, with state and ports.',
      },
      {
        name: 'stats',
        usage: 'bundant stats [path]',
        description: 'One resource snapshot for the matched units.',
      },
      {
        name: 'events',
        usage: 'bundant events [--since 2h]',
        description: 'Runtime events inside a bounded window (default 2h).',
      },
    ],
  },
];

export const commandCount = commandGroups.reduce((total, group) => total + group.commands.length, 0);
