/**
 * The rehearsal's sanitizer: every result file is written through it.
 *
 *   bun sanitize.ts <values-file> < raw > sanitized
 *
 * <values-file> holds one entry per line, `secret <value>` for a value the
 * harness generated (the vault password, the TURN secret, the database
 * password) or `path <value> <name>` for a local path or name to replace by
 * <name> (the work, tool and repository directories, the home directory, the
 * user name, the host name). It replaces:
 *   - each secret, in plain text and as base64, base64url, hex (either case)
 *     and percent-encoding of its bytes, by <redacted>;
 *   - each path, also as ansible-core prints it once a vaulted value inside it
 *     is masked ("p2party" becomes "$REDACTED$"), by its name;
 *   - every PEM block holding a private key, by <private key redacted>;
 *   - terminal colour codes.
 * It does not know values it did not generate or that it is not given:
 * secrets made inside the guest that a playbook prints, a secret split across
 * lines, or one in an encoding not listed here.
 */

export interface Replacement {
  from: string;
  to: string;
}

const encodings = (value: string): string[] => {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const percent = [...bytes]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  return [
    value,
    base64,
    base64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    encodeURIComponent(value),
    percent,
    percent.toLowerCase(),
  ];
};

export function replacements(valuesText: string): Replacement[] {
  const list: Replacement[] = [];
  for (const line of valuesText.split("\n")) {
    const [kind, ...rest] = line.split(" ");
    if (kind === "secret" && rest.length > 0) {
      const value = rest.join(" ");
      if (value.length < 8)
        throw new Error(
          "a secret shorter than 8 characters cannot be told from ordinary text",
        );
      for (const form of encodings(value))
        list.push({ from: form, to: "<redacted>" });
    } else if (kind === "path" && rest.length >= 2) {
      const name = rest.at(-1)!;
      const value = rest.slice(0, -1).join(" ");
      if (value.length < 3) continue;
      list.push({ from: value, to: name });
      if (value.includes("p2party"))
        list.push({
          from: value.replaceAll("p2party", "$REDACTED$"),
          to: name,
        });
    }
  }
  // Longest first, so a path is replaced before a shorter name inside it.
  return list.sort((a, b) => b.from.length - a.from.length);
}

const PRIVATE_KEY =
  /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

export function sanitize(text: string, list: Replacement[]): string {
  let out = text.replace(PRIVATE_KEY, "<private key redacted>");
  for (const { from, to } of list) out = out.split(from).join(to);
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

if (import.meta.main) {
  const [valuesPath] = process.argv.slice(2);
  if (!valuesPath) {
    console.error("usage: bun sanitize.ts <values-file> < raw > sanitized");
    process.exit(2);
  }
  const list = replacements(await Bun.file(valuesPath).text());
  process.stdout.write(sanitize(await Bun.stdin.text(), list));
}
