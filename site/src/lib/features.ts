export type FeatureIcon =
  | 'route'
  | 'boxes'
  | 'layers'
  | 'shield-check'
  | 'container'
  | 'activity';

export type Feature = {
  title: string;
  description: string;
  icon: FeatureIcon;
};

/** Exactly the shipped capabilities the homepage claims. */
export const features: Feature[] = [
  {
    title: 'Zero-downtime deploy',
    description:
      'The new revision starts unpublished and passes a health gate. One atomic proxy swap moves traffic and drains old connections; the previous revision stays for rollback.',
    icon: 'route',
  },
  {
    title: 'Groups and protected accessories',
    description:
      'A group is a namespace: install services in needs: order, aggregate status, roll back to one sha. Stateful accessories keep stable names and named volumes and are never touched by deploy, rollback or prune.',
    icon: 'boxes',
  },
  {
    title: 'Replicas with manual scale',
    description:
      'Run N copies of one service per host and scale up or down on demand. New targets are gated before the proxy swap, and scale-down drains before containers stop.',
    icon: 'layers',
  },
  {
    title: 'Preflight validation',
    description:
      'validate parses deploy.yml, group.yml or accessory.yml and prints the resolved identity plus the full error list. An invalid config never contacts a host.',
    icon: 'shield-check',
  },
  {
    title: 'Docker and Podman',
    description:
      'One typed engine API, two runtimes through their native APIs. Set runtime: podman and every step targets Podman directly — no docker shim, no compatibility layer.',
    icon: 'container',
  },
  {
    title: 'Read-only observability',
    description:
      'ps, logs, stats, events, status and a local ui page, all pull-on-demand over the same ssh connection. Nothing is installed on the host and nothing stays resident.',
    icon: 'activity',
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

export const installCommands = [
  { label: 'npm', command: 'npm i -g bundant' },
  { label: 'bun', command: 'bun add -g bundant' },
];
