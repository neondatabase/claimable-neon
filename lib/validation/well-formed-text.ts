/**
 * Postgres jsonb refuses the escape `JSON.stringify` writes for an unpaired surrogate. In `u` mode
 * a valid pair is one code point, so `\p{Cs}` matches only unpaired ones. `isWellFormed` is ES2024.
 */
export const isWellFormedText = (value: string): boolean => !/\p{Cs}/u.test(value);
