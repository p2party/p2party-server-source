import { describe, expect, test } from "bun:test";

import {
  areBoundedLabels,
  isBoundedCandidate,
  isBoundedDescription,
  isProtocolV3,
  MAX_DATA_CHANNEL_LABELS,
  MAX_ICE_CANDIDATE_CHARS,
  MAX_SDP_CHARS,
} from "./protocolV3";

describe("protocol-v3 signaling boundary", () => {
  test("accepts only exact version 3", () => {
    expect(isProtocolV3(3)).toBe(true);
    expect(isProtocolV3(2)).toBe(false);
    expect(isProtocolV3("3")).toBe(false);
    expect(isProtocolV3(undefined)).toBe(false);
  });

  test("bounds descriptions, candidates, and labels", () => {
    expect(isBoundedDescription({ type: "offer", sdp: "x" })).toBe(true);
    expect(isBoundedDescription({ sdp: "x".repeat(MAX_SDP_CHARS) })).toBe(
      false,
    );
    expect(isBoundedCandidate({ candidate: "x" })).toBe(true);
    expect(
      isBoundedCandidate({
        candidate: "x".repeat(MAX_ICE_CANDIDATE_CHARS),
      }),
    ).toBe(false);
    expect(areBoundedLabels(["main"])).toBe(true);
    expect(
      areBoundedLabels(Array.from({ length: MAX_DATA_CHANNEL_LABELS + 1 })),
    ).toBe(false);
  });
});
