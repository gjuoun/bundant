export type FeatureIcon =
  | 'boxes'
  | 'layers'
  | 'route'
  | 'shield-check'
  | 'container'
  | 'activity'
  | 'wand'
  | 'terminal';

export type Feature = {
  title: string;
  description: string;
  icon: FeatureIcon;
};

/** Every one of these maps to behaviour that ships in bundant 0.1.0. */
export const features: Feature[] = [
  {
    title: 'Groups and accessories',
    description:
      'A group is a namespace: install services in dependency order with needs:, aggregate their status, roll the whole set back to one sha. Databases and queues live as accessories with stable names and named volumes.',
    icon: 'boxes',
  },
  {
    title: 'Replicas and scale',
    description:
      'Run N copies of one service on one host and let kamal-proxy round-robin between them. scale adds or removes targets before containers are drained, so no request is dropped.',
    icon: 'layers',
  },
  {
    title: 'Config v2 naming',
    description:
      'v1 keeps the historical hyphen names; v2 uses dots as structural separators. Validate, migrate and keep the naming scheme that matches your fleet.',
    icon: 'route',
  },
  {
    title: 'Preflight validation',
    description:
      'bundant validate parses deploy.yml, group.yml or accessory.yml and prints the resolved identity plus the full error list. It never contacts a host.',
    icon: 'shield-check',
  },
  {
    title: 'Docker and Podman adapters',
    description:
      'One typed engine API, two runtimes. Set runtime: podman and every emitted step switches binary — pull, network, run, exec, ps, save. No docker shim.',
    icon: 'container',
  },
  {
    title: 'Monitoring and UI',
    description:
      'status, logs, stats, ps, events and inspect over the same multiplexed ssh connection. bundant ui is a local, read-only page on 127.0.0.1 — nothing resident on the host.',
    icon: 'activity',
  },
  {
    title: 'One-command bootstrap',
    description:
      'bundant bootstrap installs podman on Debian, Fedora, Alpine, Arch and openSUSE hosts, enables boot-time restart, sets the registry search path and smoke-tests a container.',
    icon: 'wand',
  },
  {
    title: 'A typed CLI foundation',
    description:
      'The command tree is declared with effect/cli, with typed errors all the way down. Shared flags, shell completions and wizard mode come for free.',
    icon: 'terminal',
  },
];

export type WhyCard = {
  title: string;
  body: string;
  detail: string;
};

export const whyCards: WhyCard[] = [
  {
    title: 'No registry required',
    body: 'Build locally, ship over the connection you already have.',
    detail:
      'bundant can stream a locally built image to the host over ssh. When you do use a registry, it pulls the pinned tag like any other runtime.',
  },
  {
    title: 'No Kubernetes',
    body: 'A box, sshd and docker or podman. That is the whole platform.',
    detail:
      'No scheduler, no control-plane daemon, no CRDs. The CLI runs, finishes and exits; hosts are cattle and deploy.yml plus the image are the truth.',
  },
  {
    title: 'Zero downtime',
    body: 'Health-gated swaps through kamal-proxy, not restart roulette.',
    detail:
      'The new revision starts unpublished, passes a health gate, then the proxy swaps its target set and drains old connections. The old container stays for rollback.',
  },
];

export type HowStep = {
  step: string;
  title: string;
  body: string;
};

export const howSteps: HowStep[] = [
  {
    step: '01',
    title: 'Describe the service',
    body: 'One deploy.yml holds the image, hosts, env, health check and proxy host. Validate it locally with no network.',
  },
  {
    step: '02',
    title: 'Start the new revision',
    body: 'bundant creates a fresh container beside the running one, on the same docker or podman network, unpublished.',
  },
  {
    step: '03',
    title: 'Pass the health gate',
    body: 'A short-lived probe container curls your health path. A failed gate stops the deploy before traffic moves.',
  },
  {
    step: '04',
    title: 'Swap and keep the old one',
    body: 'kamal-proxy switches the target set in one call and drains old connections. Previous revisions stay for rollback and prune.',
  },
];

/** Real output of `bundant deploy --dry-run -f examples/hello/deploy.yml`, trimmed for the page. */
export const dryRunExcerpt = `bundant deploy plan (via api)
  hello/web rev=59ceb8d runtime=podman
hosts: replace-me.example.ts.net

  1) [ssh] host prerequisites
  2) [pull] POST /images/create
  3) [network] POST /networks/create
  4) [run] POST /containers/create
  5) [health] probe -> GET /logs
  6) [proxy-ensure] GET /kamal-proxy
  7) [proxy-swap] kamal-proxy deploy
  8) [stop-old] POST /stop?t=10`;

export const installCommands = [
  { label: 'npm', command: 'npm i -g bundant' },
  { label: 'bun', command: 'bun add -g bundant' },
];
