import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

/**
 * Prettier reads only the working directory's .gitignore and .prettierignore,
 * not nested ones such as deploy/terraform/.gitignore (Terraform state) or
 * deploy/ansible/.gitignore (the vault, the real inventory). The format
 * scripts therefore have to hand Prettier the tracked files only. This runs
 * the repository's own `format` and `format:check` scripts in a scratch git
 * repository and checks that an untracked state file and an ignored vault
 * file, both badly formatted, are neither reported nor rewritten.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const UNTRACKED_STATE = '{"untracked":true}\n';
const IGNORED_VAULT = "secret:    1\n";

test(
  "the format scripts only touch tracked files",
  () => {
    const work = mkdtempSync(join(tmpdir(), "p2party-format-"));
    try {
      const { scripts } = JSON.parse(
        readFileSync(join(repositoryRoot, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      writeFileSync(
        join(work, "package.json"),
        `${JSON.stringify(
          {
            name: "format-probe",
            private: true,
            scripts: {
              format: scripts.format,
              "format:check": scripts["format:check"],
            },
          },
          null,
          2,
        )}\n`,
      );
      for (const file of [".gitignore", ".prettierignore", ".prettierrc"])
        cpSync(join(repositoryRoot, file), join(work, file));
      symlinkSync(
        join(repositoryRoot, "node_modules"),
        join(work, "node_modules"),
      );
      writeFileSync(join(work, "tracked.ts"), "export const tracked = 1;\n");
      writeFileSync(join(work, "deleted.ts"), "export const deleted = 1;\n");
      writeFileSync(join(work, "x.tfstate"), UNTRACKED_STATE);
      mkdirSync(join(work, "deploy", "ansible", "group_vars", "all"), {
        recursive: true,
      });
      writeFileSync(
        join(work, "deploy", "ansible", ".gitignore"),
        "group_vars/all/vault.yml\n",
      );
      const vault = join(work, "deploy", "ansible", "group_vars", "all");
      writeFileSync(join(vault, "vault.yml"), IGNORED_VAULT);

      const run = (...argv: string[]) => {
        const child = Bun.spawnSync(argv, {
          cwd: work,
          env: {
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            HOME: work,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: child.exitCode,
          output: `${child.stdout.toString()}${child.stderr.toString()}`,
        };
      };
      expect(run("git", "init", "-q").exitCode).toBe(0);
      expect(
        run(
          "git",
          "add",
          "package.json",
          ".gitignore",
          ".prettierignore",
          ".prettierrc",
          "tracked.ts",
          "deleted.ts",
          "deploy/ansible/.gitignore",
        ).exitCode,
      ).toBe(0);
      // The vault is ignored by the nested .gitignore; the state file is not
      // ignored, only untracked.
      expect(
        run(
          "git",
          "check-ignore",
          "-q",
          "deploy/ansible/group_vars/all/vault.yml",
        ).exitCode,
      ).toBe(0);
      expect(run("git", "check-ignore", "-q", "x.tfstate").exitCode).toBe(1);
      expect(run("git", "ls-files").output).not.toMatch(/x\.tfstate|vault/);

      const bun = process.execPath;
      // Outside a git work tree there is no file list; the check must fail
      // rather than pass having checked nothing.
      const gitDir = join(work, ".git");
      const hidden = join(work, "git-hidden");
      cpSync(gitDir, hidden, { recursive: true });
      rmSync(gitDir, { recursive: true, force: true });
      expect(run(bun, "run", "format:check").exitCode).not.toBe(0);
      cpSync(hidden, gitDir, { recursive: true });
      rmSync(hidden, { recursive: true, force: true });

      const check = run(bun, "run", "format:check");
      expect(check.output).not.toContain("x.tfstate");
      expect(check.output).not.toContain("vault.yml");
      expect(check.exitCode, check.output).toBe(0);

      const write = run(bun, "run", "format");
      expect(write.output).not.toContain("x.tfstate");
      expect(write.output).not.toContain("vault.yml");
      expect(write.exitCode, write.output).toBe(0);
      expect(readFileSync(join(work, "x.tfstate"), "utf8")).toBe(
        UNTRACKED_STATE,
      );
      expect(readFileSync(join(vault, "vault.yml"), "utf8")).toBe(
        IGNORED_VAULT,
      );

      // A tracked file deleted in the work tree (still in the index) is
      // skipped, not an error.
      rmSync(join(work, "deleted.ts"));
      expect(run("git", "ls-files").output).toContain("deleted.ts");
      const afterDelete = run(bun, "run", "format:check");
      expect(afterDelete.exitCode, afterDelete.output).toBe(0);
      expect(run(bun, "run", "format").exitCode).toBe(0);

      // The scripts do check and rewrite a tracked file.
      writeFileSync(join(work, "tracked.ts"), "export const tracked=1\n");
      const unformatted = run(bun, "run", "format:check");
      expect(unformatted.exitCode).not.toBe(0);
      expect(unformatted.output).toContain("tracked.ts");
      expect(run(bun, "run", "format").exitCode).toBe(0);
      expect(readFileSync(join(work, "tracked.ts"), "utf8")).toBe(
        "export const tracked = 1;\n",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
