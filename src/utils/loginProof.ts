/** The public WebSocket authority, including a non-default port when used. */
export const requireSignalingHost = (value: string | undefined): string => {
  const host = value?.toLowerCase();
  if (host) {
    for (const scheme of ["ws", "wss"]) {
      if (
        URL.canParse(`${scheme}://${host}`) &&
        new URL(`${scheme}://${host}`).host === host
      )
        return host;
    }
  }
  throw new Error("SIGNALING_HOST must contain the public WebSocket URL.host");
};

export const loginProof = (host: string, nonceHex: string): Uint8Array =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from(`p2party-signaling-auth-v2\0${host}\0`, "utf8"),
      Buffer.from(nonceHex, "hex"),
    ]),
  );
