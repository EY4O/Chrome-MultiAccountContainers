// When a container counts as idle. Pure, so the threshold can be unit-tested.

/** Ids of containers last used at least `timeoutMinutes` ago; never used counts as long ago. */
export function idleIds(lastUsed: Record<string, number>, ids: string[], timeoutMinutes: number, now: number): string[] {
  const limit = timeoutMinutes * 60_000;
  return ids.filter((id) => now - (lastUsed[id] ?? 0) >= limit);
}
