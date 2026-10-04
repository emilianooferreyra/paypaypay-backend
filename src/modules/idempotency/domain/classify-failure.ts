export type FailureAction = "fail" | "discard" | "unlock";

/**
 * What to do with a claimed key when the handler failed with `status`.
 * Only answers that are deterministic for the request are stored; anything
 * unknown is treated as transient so a retry can still succeed.
 */
export function classifyFailure(status: number | undefined): FailureAction {
  if (status === 404 || status === 422) return "fail";
  if (status === 400) return "discard";

  return "unlock";
}
