/**
 * Default observer ordering (brief + D8):
 * qualified by S desc, then valid-but-unqualified by displayed-side S desc,
 * then neutral (H = 0, no rank), then unavailable (no rank). Tie-break by root alphabetically.
 * Rank compares scores; it is not a probability.
 */
import type { SignalSnapshot } from "../formula/types";

export type RankGroup = "qualified" | "unqualified" | "neutral" | "unavailable";

export interface RankedEntry {
  root: SignalSnapshot["root"];
  group: RankGroup;
  /** 1-based rank among ranked (qualified + unqualified) entries; null for neutral/unavailable. */
  rank: number | null;
  /** Score used for ordering; null when unranked. */
  score: number | null;
  snapshot: SignalSnapshot;
}

const GROUP_ORDER: Record<RankGroup, number> = { qualified: 0, unqualified: 1, neutral: 2, unavailable: 3 };

export function groupOf(s: SignalSnapshot): RankGroup {
  switch (s.status) {
    case "QUALIFIED":
      return "qualified";
    case "WAIT":
      return "unqualified";
    case "NEUTRAL":
      return "neutral";
    case "UNAVAILABLE":
      return "unavailable";
  }
}

export function rankSnapshots(snapshots: readonly SignalSnapshot[]): RankedEntry[] {
  const entries = snapshots.map((snapshot) => {
    const group = groupOf(snapshot);
    const ranked = group === "qualified" || group === "unqualified";
    const score = ranked && Number.isFinite(snapshot.displayScore ?? Number.NaN) ? snapshot.displayScore : null;
    return { root: snapshot.root, group, rank: null as number | null, score, snapshot };
  });

  entries.sort((x, y) => {
    const g = GROUP_ORDER[x.group] - GROUP_ORDER[y.group];
    if (g !== 0) return g;
    if (x.score !== null && y.score !== null && x.score !== y.score) return y.score - x.score;
    return x.root < y.root ? -1 : x.root > y.root ? 1 : 0;
  });

  let rank = 0;
  for (const e of entries) {
    if (e.group === "qualified" || e.group === "unqualified") e.rank = ++rank;
  }
  return entries;
}

/** Highest-ranked qualified snapshot, or null when none qualifies (no forced trading). */
export function topQualified(snapshots: readonly SignalSnapshot[]): SignalSnapshot | null {
  const first = rankSnapshots(snapshots).find((e) => e.group === "qualified");
  return first ? first.snapshot : null;
}
