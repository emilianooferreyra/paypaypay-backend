export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

/** A value in [0, 1], injected so jitter is deterministic in tests. */
export type Random = () => number;

export const RANDOM = Symbol("RANDOM");
