import { RawConfigSchema } from "./deploy.ts";

/**
 * v1 has one deploy/accessory schema: the file is distinguished by
 * \`kind: accessory\` plus \`proxy.enabled: false\`, not by a different shape.
 * Keeping the alias explicit makes the versioned schema generator produce an
 * accessory file without forking the rules.
 */
export const AccessorySchema = RawConfigSchema;
