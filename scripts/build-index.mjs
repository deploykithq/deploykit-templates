#!/usr/bin/env node
/**
 * Rebuilds index.json from blueprints/, and games/index.json from games/.
 *
 * `index.json` is the only file DeployKit reads to render the catalogue page,
 * so it has to be regenerated whenever a blueprint is added or its metadata
 * changes. `games/index.json` plays the same role for the game servers page.
 * `scripts/validate.mjs` fails when either is stale.
 *
 * The output must stay byte-identical to what DeployKit's own
 * `packages/templates/scripts/generate.ts` produces, since either repository
 * may be the one that regenerates it: same field order, two-space JSON,
 * trailing newline.
 *
 *   node scripts/build-index.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Same shape as DeployKit's `gameMetaSchema`: the blueprint metadata plus
// `category` and `players`. `validate.mjs` derives the identical list.
const gamesDir = path.join(root, "games");

const gameMeta = (spec) => ({
  id: spec.id,
  name: spec.name,
  version: spec.version,
  description: spec.description,
  ...(spec.logo ? { logo: spec.logo } : {}),
  links: spec.links ?? {},
  tags: spec.tags ?? [],
  ...(spec.category ? { category: spec.category } : {}),
  ...(spec.players ? { players: { min: spec.players.min, max: spec.players.max } } : {}),
});

if (existsSync(gamesDir)) {
  const games = readdirSync(gamesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((id) =>
      gameMeta(JSON.parse(readFileSync(path.join(gamesDir, id, "game.json"), "utf8"))),
    );

  writeFileSync(
    path.join(gamesDir, "index.json"),
    JSON.stringify(games, null, 2) + "\n",
  );

  console.log(`Wrote games/index.json with ${games.length} game(s).`);
}
