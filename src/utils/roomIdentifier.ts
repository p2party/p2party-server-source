export const deriveRoomIdentifier = (roomUrl: string): string => {
  if (!/^[0-9a-f]{64}$/.test(roomUrl))
    throw new Error("Room token must be 64 lowercase hexadecimal characters");

  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(roomUrl);
  return hasher.digest("hex").toLowerCase();
};
