/** The one signaling protocol version this server speaks; there is no negotiation. */
export const PROTOCOL_VERSION = 4;
/**
 * The close for a frame whose `protocolVersion` is not PROTOCOL_VERSION, or
 * that has none (only `pong` carries no version). 1003 is the close-code
 * contract's build-mismatch code (MALFORMED_PROTOCOL_CLOSE_CODE in
 * socketAuth.ts): the same build sends the same version on every socket, so
 * the client's reconnect ladder must stop rather than retry. The reason names
 * only this server's version, never a value the client sent.
 */
export const PROTOCOL_VERSION_MISMATCH_CLOSE_CODE = 1003;
export const PROTOCOL_VERSION_MISMATCH_REASON = `Unsupported signaling protocol version; this server speaks version ${String(PROTOCOL_VERSION)}`;
export const MAX_SIGNALING_MESSAGE_CHARS = 512 * 1024;
export const MAX_SDP_CHARS = 256 * 1024;
export const MAX_ICE_CANDIDATE_CHARS = 4096;
export const MAX_ICE_FIELD_CHARS = 256;
export const MAX_DATA_CHANNEL_LABELS = 64;
export const MAX_DATA_CHANNEL_LABEL_CHARS = 193;

export const isProtocolV4 = (value: unknown): value is 4 =>
  value === PROTOCOL_VERSION;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Exact projection of the SDK's protocol-v4 signaling bounds.
 *
 * The limits apply to the browser fields, not JSON wrapper overhead. Keeping
 * this shape identical on both sides prevents an SDK-valid boundary value from
 * being rejected by the server and prevents the server from forwarding a value
 * the receiving SDK cannot admit.
 */
export const isBoundedDescription = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const type = value.type;
  return (
    (type === "offer" ||
      type === "answer" ||
      type === "pranswer" ||
      type === "rollback") &&
    typeof value.sdp === "string" &&
    value.sdp.length <= MAX_SDP_CHARS
  );
};

export const isBoundedCandidate = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.candidate !== "string") return false;
  return (
    value.candidate.length <= MAX_ICE_CANDIDATE_CHARS &&
    (value.sdpMid == null ||
      (typeof value.sdpMid === "string" &&
        value.sdpMid.length <= MAX_ICE_FIELD_CHARS)) &&
    (value.usernameFragment == null ||
      (typeof value.usernameFragment === "string" &&
        value.usernameFragment.length <= MAX_ICE_FIELD_CHARS))
  );
};

export const areBoundedLabels = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_DATA_CHANNEL_LABELS &&
  value.every(
    (label) =>
      typeof label === "string" &&
      label.length > 0 &&
      label.length <= MAX_DATA_CHANNEL_LABEL_CHARS,
  );
