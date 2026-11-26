/**
 * A refusal this server raises itself, whose message is a fixed sentence
 * written here (never built from a request, an id or a caught value), so the
 * operator log may print it to say which refusal happened.
 */
export class ServerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * What an operator log may say about a caught value: its class and, for a
 * database or driver error, its code. Never its message or its fields: a
 * Prisma validation error's message quotes the query's arguments, peer ids
 * and room ids included, and a driver error can carry the statement.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof ServerRefusal)
    return `${error.constructor.name}: ${error.message}`;
  if (!(error instanceof Error))
    return error === null ? "null" : `non-Error ${typeof error}`;
  const name = error.constructor?.name || error.name || "Error";
  const { code, errorCode } = error as { code?: unknown; errorCode?: unknown };
  const databaseCode = typeof code === "string" ? code : errorCode;
  // Prisma codes (P2034), SQLSTATEs (40001) and system error codes
  // (ECONNREFUSED) are short upper-case words and carry no data.
  return typeof databaseCode === "string" &&
    /^[A-Z0-9_]{1,24}$/.test(databaseCode)
    ? `${name} ${databaseCode}`
    : name;
};
