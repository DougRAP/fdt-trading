/**
 * Event ids for user-initiated writes. Never derived from minute-resolution timestamps, so two
 * writes in the same minute (or with identical fill times) cannot collide.
 */
let counter = 0;

export function newEventId(prefix: string): string {
  counter += 1;
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}:${counter}`;
}
