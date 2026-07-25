export const PROTOCOL_VERSION = 4;
export const MAX_SIGNALING_MESSAGE_CHARS = 512 * 1024;
export const MAX_SDP_CHARS = 256 * 1024;
export const MAX_ICE_CANDIDATE_CHARS = 4096;
export const MAX_DATA_CHANNEL_LABELS = 64;
export const MAX_DATA_CHANNEL_LABEL_CHARS = 256;

export const isProtocolV4 = (value: unknown): value is 4 =>
  value === PROTOCOL_VERSION;

const serializedLengthAtMost = (value: unknown, limit: number): boolean => {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.length <= limit;
  } catch {
    return false;
  }
};

export const isBoundedDescription = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  serializedLengthAtMost(value, MAX_SDP_CHARS);

export const isBoundedCandidate = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  serializedLengthAtMost(value, MAX_ICE_CANDIDATE_CHARS);

export const areBoundedLabels = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_DATA_CHANNEL_LABELS &&
  value.every(
    (label) =>
      typeof label === "string" &&
      label.length > 0 &&
      label.length <= MAX_DATA_CHANNEL_LABEL_CHARS,
  );
