import { describe, expect, it } from "vitest";

import {
  READING_SESSION_SOURCE_BUCKETS,
  READING_SESSION_SOURCE_BUCKET_LABELS,
  emptySourceBucketRecord,
  toReadingSessionSourceBucket,
} from "../reading-session-source-bucket";

describe("toReadingSessionSourceBucket", () => {
  it("maps web to bookorbit", () => {
    expect(toReadingSessionSourceBucket("web")).toBe("bookorbit");
  });

  it("maps manual to bookorbit", () => {
    expect(toReadingSessionSourceBucket("manual")).toBe("bookorbit");
  });

  it("maps koreader to koreader", () => {
    expect(toReadingSessionSourceBucket("koreader")).toBe("koreader");
  });

  it("maps kobo to kobo", () => {
    expect(toReadingSessionSourceBucket("kobo")).toBe("kobo");
  });

  it("maps crosspoint to crosspoint", () => {
    expect(toReadingSessionSourceBucket("crosspoint")).toBe("crosspoint");
  });

  it("maps audiobookshelf to audiobookshelf", () => {
    expect(toReadingSessionSourceBucket("audiobookshelf")).toBe("audiobookshelf");
  });

  it("maps physical to physical", () => {
    expect(toReadingSessionSourceBucket("physical")).toBe("physical");
  });

  it("maps null/undefined to bookorbit", () => {
    expect(toReadingSessionSourceBucket(null)).toBe("bookorbit");
    expect(toReadingSessionSourceBucket(undefined)).toBe("bookorbit");
  });
});

describe("reading session source bucket constants", () => {
  it("exposes exactly six buckets", () => {
    expect(READING_SESSION_SOURCE_BUCKETS).toEqual(["bookorbit", "koreader", "kobo", "crosspoint", "audiobookshelf", "physical"]);
  });

  it("labels every bucket", () => {
    expect(READING_SESSION_SOURCE_BUCKET_LABELS).toEqual({
      bookorbit: "BookOrbit",
      koreader: "KOReader",
      kobo: "Kobo",
      crosspoint: "Crosspoint",
      audiobookshelf: "Audiobookshelf",
      physical: "Physical",
    });
  });

  it("builds a zero-filled record", () => {
    expect(emptySourceBucketRecord()).toEqual({ bookorbit: 0, koreader: 0, kobo: 0, crosspoint: 0, audiobookshelf: 0, physical: 0 });
  });
});
