/** What came back from one attempt to call an endpoint. */
export type DeliveryOutcome =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "failure"; readonly reason: string };

export type Verdict = "delivered" | "retryable" | "permanent";

export interface RetryPolicy {
  /** Total attempts, the first one included. */
  readonly maxAttempts: number;
  /** Wait before retry N is `delaysMs[N - 1]`; the last entry repeats. */
  readonly delaysMs: readonly number[];
  /** 0.2 spreads every delay by up to 20% in both directions. */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delaysMs: [60_000, 300_000, 900_000],
  jitterRatio: 0.2,
};

export type DeliveryDecision =
  | {
      readonly status: "delivered";
      readonly attempts: number;
      readonly responseStatus: number;
    }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly nextRetryAt: Date;
      readonly lastError: string;
      readonly responseStatus?: number;
    }
  | {
      readonly status: "dead";
      readonly attempts: number;
      readonly lastError: string;
      readonly responseStatus?: number;
    };

/**
 * 2xx is delivered. Network errors, timeouts, 5xx, 408 and 429 are worth
 * trying again. Everything else is permanent: a 400 or 404 will not fix itself,
 * and a redirect is never followed because it could lead to a host nobody
 * registered.
 */
export function classify(outcome: DeliveryOutcome): Verdict {
  if (outcome.kind === "failure") return "retryable";

  const { status } = outcome;
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  return "permanent";
}

/**
 * `attemptsMade` is how many attempts have already happened (at least 1).
 * `random` returns a value in [0, 1]; jitter keeps endpoints that recover
 * together from being hit in lockstep.
 */
export function retryDelayMs(
  attemptsMade: number,
  random: () => number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const index = Math.min(Math.max(attemptsMade, 1), policy.delaysMs.length) - 1;
  const base = policy.delaysMs[index];
  const spread = 1 + (random() * 2 - 1) * policy.jitterRatio;

  return Math.max(1, Math.round(base * spread));
}

export function decide(
  attemptsBefore: number,
  outcome: DeliveryOutcome,
  now: Date,
  random: () => number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): DeliveryDecision {
  const attempts = attemptsBefore + 1;
  const responseStatus =
    outcome.kind === "response" ? outcome.status : undefined;
  const lastError =
    outcome.kind === "response" ? `HTTP ${outcome.status}` : outcome.reason;

  const verdict = classify(outcome);

  if (verdict === "delivered" && responseStatus !== undefined) {
    return { status: "delivered", attempts, responseStatus };
  }

  if (verdict === "permanent" || attempts >= policy.maxAttempts) {
    return { status: "dead", attempts, responseStatus, lastError };
  }

  return {
    status: "failed",
    attempts,
    responseStatus,
    lastError,
    nextRetryAt: new Date(
      now.getTime() + retryDelayMs(attempts, random, policy),
    ),
  };
}
