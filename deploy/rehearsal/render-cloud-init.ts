/**
 * Renders a tracked Terraform cloud-init template with rehearsal values, the
 * way `templatefile()` in deploy/terraform/p2party_signaling.tf does:
 *
 *   bun render-cloud-init.ts <template.tpl> <public-key-file> <ssh-port>
 *
 * Terraform substitutes `${name}` and turns `$${` into a literal `${`. The
 * signaling template uses four names; `ssh_keys` is rendered as
 * p2party_signaling.tf renders it (each key as a YAML list item, joined with
 * the template's indentation). A `%{` directive or an unknown name is an error
 * rather than being passed through, so a template change cannot slip by.
 */

export function renderCloudInit(
  template: string,
  values: Record<string, string>,
): string {
  if (template.includes("%{")) {
    throw new Error(
      "the template uses a %{ directive, which this does not render",
    );
  }
  const escaped = "\u0000ESCAPED_DOLLAR_BRACE\u0000";
  const rendered = template
    .replaceAll("$${", escaped)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`the template names \${${name}}, which has no value`);
      }
      return value;
    });
  if (rendered.includes("${")) {
    throw new Error("an interpolation was left unrendered");
  }
  return rendered.replaceAll(escaped, "${");
}

if (import.meta.main) {
  const [templatePath, keyPath, sshPort] = process.argv.slice(2);
  if (!templatePath || !keyPath || !sshPort) {
    console.error(
      "usage: bun render-cloud-init.ts <template.tpl> <public-key-file> <ssh-port>",
    );
    process.exit(2);
  }
  const keys = (await Bun.file(keyPath).text())
    .split("\n")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  process.stdout.write(
    renderCloudInit(await Bun.file(templatePath).text(), {
      ansible_user: "p2party",
      ssh_port: sshPort,
      app_port: "3001",
      ssh_keys: `- ${keys.join("\n      - ")}`,
    }),
  );
}
