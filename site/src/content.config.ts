import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * Docs are generated from the repository's docs/*.md by scripts/sync-docs.mjs
 * before dev/build (see package.json). This collection is the Starlight view
 * of that directory, not a second copy of the content.
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
