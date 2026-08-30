#!/usr/bin/env node
/**
 * Rebuilds index.json from blueprints/.
 *
 * `index.json` is the only file DeployKit reads to render the catalogue page,
 * so it has to be regenerated whenever a blueprint is added or its metadata
 * changes. `scripts/validate.mjs` fails when it is stale.
 *
 * The output must stay byte-identical to what DeployKit's own
 * `packages/templates/scripts/generate.ts` produces, since either repository
 * may be the one that regenerates it: same field order, two-space JSON,
 * trailing newline.
 *
 *   node scripts/build-index.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blueprintsDir = path.join(root, "blueprints");

const index = readdirSync(blueprintsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((id) => {
    const spec = JSON.parse(
      readFileSync(path.join(blueprintsDir, id, "template.json"), "utf8"),
    );
    return {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      description: spec.description,
      ...(spec.logo ? { logo: spec.logo } : {}),
      links: spec.links ?? {},
      tags: spec.tags ?? [],
    };
  });

writeFileSync(
  path.join(root, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
);

console.log(`Wrote index.json with ${index.length} blueprint(s).`);
