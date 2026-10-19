/**
 * Compile-time key guards for the wire schemas.
 *
 * Annotating a schema with `z.ZodType<Wire>` is not enough on its own: the
 * generated OpenAPI types mark almost every property optional, so a *renamed*
 * field still satisfies "assignable to Wire" (the field is simply missing, and
 * the target type allows that). The guard below rejects any key the schema
 * declares that the spec does not — the failure mode that actually happens when
 * an engine renames a field.
 *
 * It reads the keys off the schema's object shape, so it works even when the
 * shape contains transforms/preprocessors (which make `z.input` unhelpful):
 *
 *   assertNoExtraKeys<ShapeKeys<typeof inspectSchema>, InspectWire>(true);
 *
 * Rename `Id` to `Idd` in the schema and `tsc` fails with
 *   Argument of type 'true' is not assignable to parameter of type 'false'.
 */

/** Keys of a ZodObject shape; never for anything else (e.g. a transformed schema). */
export type ShapeKeys<S> = S extends { shape: infer Shape } ? keyof Shape : never;

/** `true` when S declares no key that W does not have. */
export type NoExtraKeys<S, W> = Exclude<S, keyof W> extends never ? true : false;

export function assertNoExtraKeys<S, W>(check: NoExtraKeys<S, W>): void {
  void check;
}

/** `true` when A is assignable to B. */
export type Assignable<A, B> = A extends B ? true : false;

/** Fails to compile when the schema's output type does not fit the wire type. */
export function assertAssignable<A, B>(check: Assignable<A, B>): void {
  void check;
}
