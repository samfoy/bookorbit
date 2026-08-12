import type { ReadingSessionSource } from "./reading-session";

export const READING_SESSION_SOURCE_BUCKETS = ["bookorbit", "koreader", "kobo", "crosspoint", "audiobookshelf", "physical"] as const;
export type ReadingSessionSourceBucket = (typeof READING_SESSION_SOURCE_BUCKETS)[number];

export const READING_SESSION_SOURCE_BUCKET_LABELS: Record<ReadingSessionSourceBucket, string> = {
  bookorbit: "BookOrbit",
  koreader: "KOReader",
  kobo: "Kobo",
  crosspoint: "Crosspoint",
  audiobookshelf: "Audiobookshelf",
  physical: "Physical",
};

// web/manual are both native BookOrbit surfaces; null/unknown (and historical Kobo-as-web
// sessions that predate source tagging) collapse into the BookOrbit bucket by design.
export function toReadingSessionSourceBucket(source: ReadingSessionSource | null | undefined): ReadingSessionSourceBucket {
  if (source === "koreader") return "koreader";
  if (source === "kobo") return "kobo";
  if (source === "crosspoint") return "crosspoint";
  if (source === "audiobookshelf") return "audiobookshelf";
  if (source === "physical") return "physical";
  return "bookorbit";
}

export function emptySourceBucketRecord(): Record<ReadingSessionSourceBucket, number> {
  return { bookorbit: 0, koreader: 0, kobo: 0, crosspoint: 0, audiobookshelf: 0, physical: 0 };
}
