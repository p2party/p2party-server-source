import { describe, expect, test } from "bun:test";

import {
  areBoundedLabels,
  isBoundedCandidate,
  isBoundedDescription,
  isProtocolV5,
  MAX_DATA_CHANNEL_LABEL_CHARS,
  MAX_DATA_CHANNEL_LABELS,
  MAX_ICE_FIELD_CHARS,
  MAX_ICE_CANDIDATE_CHARS,
  MAX_SDP_CHARS,
} from "../../src/utils/signalingProtocol";

describe("protocol-v5 signaling boundary", () => {
  test("accepts only exact version 5", () => {
    expect(isProtocolV5(5)).toBe(true);
    expect(isProtocolV5(4)).toBe(false);
    expect(isProtocolV5(2)).toBe(false);
    expect(isProtocolV5("4")).toBe(false);
    expect(isProtocolV5(undefined)).toBe(false);
  });

  test("bounds descriptions, candidates, and labels", () => {
    expect(isBoundedDescription({ type: "offer", sdp: "x" })).toBe(true);
    expect(
      isBoundedDescription({ type: "offer", sdp: "x".repeat(MAX_SDP_CHARS) }),
    ).toBe(true);
    expect(
      isBoundedDescription({
        type: "offer",
        sdp: "x".repeat(MAX_SDP_CHARS + 1),
      }),
    ).toBe(false);
    expect(isBoundedDescription({ sdp: "x" })).toBe(false);
    expect(isBoundedCandidate({ candidate: "x" })).toBe(true);
    expect(
      isBoundedCandidate({
        candidate: "x".repeat(MAX_ICE_CANDIDATE_CHARS),
      }),
    ).toBe(true);
    expect(
      isBoundedCandidate({
        candidate: "x".repeat(MAX_ICE_CANDIDATE_CHARS + 1),
      }),
    ).toBe(false);
    expect(
      isBoundedCandidate({
        candidate: "x",
        sdpMid: "x".repeat(MAX_ICE_FIELD_CHARS + 1),
      }),
    ).toBe(false);
    expect(areBoundedLabels(["main"])).toBe(true);
    expect(areBoundedLabels(["x".repeat(MAX_DATA_CHANNEL_LABEL_CHARS)])).toBe(
      true,
    );
    expect(
      areBoundedLabels(["x".repeat(MAX_DATA_CHANNEL_LABEL_CHARS + 1)]),
    ).toBe(false);
    expect(
      areBoundedLabels(
        Array.from({ length: MAX_DATA_CHANNEL_LABELS + 1 }, () => "main"),
      ),
    ).toBe(false);
  });
});
