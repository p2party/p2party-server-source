import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("the generated viewer function preserves the public build's paths and receipt queries", () => {
  const directory = resolve(process.env.P2PARTY_SITE_DIST || "dist");
  const result = execFileSync(
    "terraform",
    [
      "console",
      "-var=stage_name=route-test",
      "-var=region=us-east-1",
      "-var=site_dist=" + directory,
    ],
    { input: "base64encode(local.viewer_code)\n", encoding: "utf8" },
  );
  const source = Buffer.from(JSON.parse(result.trim()), "base64").toString(
    "utf8",
  );
  const handler = runInNewContext(source + "\nhandler");
  function check(uri, expected, method = "GET") {
    const querystring = { receipt: { value: "1" } };
    const request = { uri, method, querystring };
    const response = handler({ request });
    assert.equal(response, request);
    assert.equal(response.uri, expected);
    assert.deepEqual(response.querystring, { receipt: { value: "1" } });
    assert.equal(response.method, method);
  }
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      const key = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        visit(key);
        continue;
      }
      const uri = "/" + key;
      check(uri, uri);
      if (entry.name === "index.html") {
        const route = uri.slice(0, -"/index.html".length);
        if (route) check(route, uri);
        check(route + "/", uri, "HEAD");
      }
    }
  }
  visit("");
  for (const uri of [
    "/.well-known/apple-app-site-association",
    "/.well-known/assetlinks.json",
    "/.well-known/apple-developer-merchantid-domain-association",
    "/apple-developer-merchantid-domain-association",
    "/downloads/missing",
    "/missing-test-fixture",
    "/missing-test-fixture/",
  ]) {
    check(uri, uri);
  }
  check("/r", "/r/index.html");
  check("/explorer/testnet/", "/explorer/testnet/index.html");
});
