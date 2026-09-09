import { expect, test } from "bun:test";
import { isUUID, isHexadecimal } from "../../src/utils/formats";

test("UUID formats retain the supported versions, variants, nil and max sentinels", () => {
  for (const version of "12345678")
    for (const variant of "89abAB") {
      const uuid = `01234567-89ab-${version}def-${variant}123-456789abcdef`;
      expect(isUUID(uuid)).toBe(true);
      expect(isUUID(uuid, 4)).toBe(version === "4");
    }
  for (const uuid of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ])
    expect(isUUID(uuid)).toBe(true);
  for (const value of [
    undefined,
    null,
    1,
    [],
    {},
    "01234567-89ab-0def-8123-456789abcdef",
    "01234567-89ab-4def-7123-456789abcdef",
  ])
    expect(isUUID(value)).toBe(false);
});

test("hex formats reject coercion and trailing line terminators", () => {
  for (const value of ["a", "ABCDEF", "0x1a", "0HA", "00"])
    expect(isHexadecimal(value)).toBe(true);
  for (const value of [null, {}, 1, "", "0x", "0h", "12g", "a b"])
    expect(isHexadecimal(value)).toBe(false);
  for (const suffix of ["\n", "\r", "\u2028", "\u2029", " "]) {
    expect(isHexadecimal("ab" + suffix)).toBe(false);
    expect(isUUID("01234567-89ab-4def-8123-456789abcdef" + suffix)).toBe(false);
  }
});
