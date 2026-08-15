declare const logicalSessionIdBrand: unique symbol;

/** Stable session identity used by contract-layer records instead of runtime ids. */
export type LogicalSessionId = string & { readonly [logicalSessionIdBrand]: "LogicalSessionId" };

export function logicalSessionId(value: string): LogicalSessionId {
  if (value.length === 0) throw new Error("logicalSessionId must not be empty");
  return value as LogicalSessionId;
}
