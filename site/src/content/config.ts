import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The docs are the repo's own markdown, not a second copy. The glob base is
 * relative to this site root, so `../docs` is the CLI's documentation.
 */
const docs = defineCollection({
  loader: glob({ pattern: '*.md', base: '../docs' }),
  schema: z.object({}).passthrough(),
});

export const collections = { docs };
