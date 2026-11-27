/** Suite IDs and field sizes are part of native transfer format version 1. */
export const signatureSuites = [
  { id: 1, algorithm: "ml-dsa-65", key: 1952, signature: 3309 },
  { id: 2, algorithm: "slh-dsa-sha2-192s", key: 48, signature: 16224 },
  { id: 3, algorithm: "ml-dsa-87", key: 2592, signature: 4627 },
  { id: 4, algorithm: "slh-dsa-shake-256s", key: 64, signature: 29792 },
] as const;

export type Suite = (typeof signatureSuites)[number]["id"];

export function isSuite(id: unknown): id is Suite {
  return signatureSuites.some((suite) => suite.id === id);
}

export function hasTransferHexLength(length: number): boolean {
  return signatureSuites.some(
    ({ key, signature }) => length === 2 + 2 * (244 + key + signature),
  );
}
