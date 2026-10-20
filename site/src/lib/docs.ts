export const docOrder = [
  'deploy-yml',
  'cli',
  'group',
  'naming',
  'replicas',
  'validation',
  'monitoring',
  'podman',
  'architecture',
  'schema',
  'api-types',
];

export const docTitles: Record<string, string> = {
  'deploy-yml': 'deploy.yml reference',
  cli: 'CLI',
  group: 'Groups and accessories',
  naming: 'Naming',
  replicas: 'Replicas and scale',
  validation: 'Validation and preflight',
  monitoring: 'Monitoring and UI',
  podman: 'Podman and nested hosts',
  architecture: 'Architecture',
  schema: 'Editor schema',
  'api-types': 'Typed engine API',
};

export const docDescriptions: Record<string, string> = {
  'deploy-yml': 'Every field, env handling and revisions.',
  cli: 'The effect/cli command tree, shared flags and completions.',
  group: 'Namespaces, needs: ordering and accessory lifecycle.',
  naming: 'v1 hyphen names, v2 dotted names and the migration.',
  replicas: 'N copies on one host, scale, and the drain ordering invariant.',
  validation: 'Preflight, what is checked, and the --json shape.',
  monitoring: 'CLI plus local UI monitoring, and what it leaves out.',
  podman: 'Rootless podman, LXC nesting and boot persistence.',
  architecture: 'Internals, proxy integration and design rules.',
  schema: 'The JSON Schemas for editor autocomplete and inline errors.',
  'api-types': 'Generated engine API types and zod at the adapter boundary.',
};

export function docTitle(slug: string) {
  return docTitles[slug] ?? slug;
}

export function docRank(slug: string) {
  const index = docOrder.indexOf(slug);
  return index === -1 ? docOrder.length : index;
}
