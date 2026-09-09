/** Protocol format checks; nonstrings and trailing whitespace are rejected. */
export const isUUID = (value: unknown, version?: 4): value is string => {
  if (typeof value !== "string" || value.length !== 36) return false;
  if (version === 4)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
    value === "00000000-0000-0000-0000-000000000000" ||
    value.toLowerCase() === "ffffffff-ffff-ffff-ffff-ffffffffffff"
  );
};

export const isHexadecimal = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:0[xh])?[0-9a-f]+$/i.test(value) &&
  !/\s/.test(value);
