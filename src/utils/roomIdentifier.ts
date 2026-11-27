/** The SDK transmits the SHA-512 identifier already used by the room index. */
export const isRoomLocator = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{128}$/.test(value);

export const requireRoomLocator = (value: string): string => {
  if (!isRoomLocator(value)) throw new Error("Invalid room locator");
  return value;
};
