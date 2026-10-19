/**
 * Compatibility facade for the v1 grammar. New code resolves the grammar from
 * the config version (src/config/registry.ts); this module keeps the existing
 * imports stable and re-exports the v1 implementation.
 */
export * from "./config/v1/grammar.ts";
