// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
);

test("@hono/node-server is a runtime dependency (Docker --omit=dev)", () => {
  expect(
    pkg.dependencies?.["@hono/node-server"],
    "server.js dynamically imports @hono/node-server; it must not live only in devDependencies",
  ).toBeTruthy();
  expect(pkg.devDependencies?.["@hono/node-server"]).toBeUndefined();
});
