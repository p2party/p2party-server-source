import packageJson from "../package.json" with { type: "json" };

/**
 * The running build's version, read from package.json at compile time so the
 * binary reports what it actually is rather than what a config file claims.
 * `bun build --compile` inlines this, so there is no file to read at runtime.
 */
export const SERVER_VERSION: string = packageJson.version;
