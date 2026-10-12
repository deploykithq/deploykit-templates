#!/usr/bin/env node
/**
 * Validates every blueprint in this catalogue.
 *
 * This is the gate on contributions: a blueprint that passes here is one
 * DeployKit can resolve and hand to `docker compose` without the author having
 * to install DeployKit. It deliberately repeats the checks DeployKit's own test
 * suite makes, because a broken blueprint published here breaks at deploy time
 * on someone else's server, where nobody can debug it.
 *
 *   node scripts/validate.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blueprintsDir = path.join(root, "blueprints");
const schemaPath = path.join(root, "schema", "template.schema.json");

/**
 * The variable helpers DeployKit understands, from
 * `apps/api/src/services/template-variables.ts`.
 *
 * Mirrored rather than imported — this repository has no dependency on
 * DeployKit. A helper added there and not here fails a valid blueprint, which
 * is loud and easy to fix; the reverse would let a broken one through.
 */
const HELPERS = new Set([
  "domain",
  "password",
  "base64",
  "hash",
  "uuid",
  "randomPort",
  "username",
  "email",
  "timestamp",
  "jwt",
]);

const PLACEHOLDER = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;

/** `$${` is the escape for a literal `${`, so it is not a reference. */
const stripEscapes = (value) => value.split("$${").join("");

const placeholdersIn = (value) => {
  const out = [];
  for (const m of stripEscapes(value).matchAll(PLACEHOLDER)) {
    out.push({ name: m[1], arg: m[2] });
  }
  return out;
};

/**
 * The `${VAR}` references Compose itself will interpolate.
 *
 * Walks the parsed document, not the raw text: Compose parses the YAML before
 * interpolating, so a `${...}` inside a comment is not a reference.
 */
const composeRefs = (doc) => {
  const found = new Set();
  const visit = (node) => {
    if (typeof node === "string") {
      for (const m of node.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)) {
        found.add(m[1]);
      }
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(doc);
  return [...found];
};

const problems = [];
const warnings = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

if (!existsSync(blueprintsDir)) {
  console.error("No blueprints/ directory");
  process.exit(1);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSpec = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

const ids = readdirSync(blueprintsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

if (ids.length === 0) {
  console.error("blueprints/ is empty");
  process.exit(1);
}

const metas = [];

for (const id of ids) {
  const dir = path.join(blueprintsDir, id);
  const specPath = path.join(dir, "template.json");
  const composePath = path.join(dir, "docker-compose.yml");

  if (!existsSync(specPath)) {
    fail(id, "missing template.json");
    continue;
  }
  if (!existsSync(composePath)) {
    fail(id, "missing docker-compose.yml");
    continue;
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (err) {
    fail(id, `template.json is not valid JSON — ${err.message}`);
    continue;
  }

  if (!validateSpec(spec)) {
    for (const e of validateSpec.errors ?? []) {
      fail(id, `template.json${e.instancePath} ${e.message}`);
    }
    continue;
  }

  if (spec.id !== id) {
    fail(id, `declares id "${spec.id}" but lives in blueprints/${id}`);
    continue;
  }

  // The catalogue serves the logo from blueprints/<id>/<logo>; a declared file
  // that is not there renders as a broken image in every install.
  if (spec.logo) {
    const logoPath = path.join(dir, spec.logo);
    if (!existsSync(logoPath)) fail(id, `declares logo "${spec.logo}" but it is missing`);
    else if (statSync(logoPath).size > 100_000) warn(id, "logo is over 100 KB");
  }

  let compose;
  try {
    compose = parseYaml(readFileSync(composePath, "utf8"));
  } catch (err) {
    fail(id, `docker-compose.yml does not parse — ${err.message}`);
    continue;
  }

  const services = compose?.services;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0) {
    fail(id, "docker-compose.yml declares no services");
    continue;
  }
  const serviceNames = Object.keys(services);

  for (const [name, service] of Object.entries(services)) {
    // DeployKit strips it at deploy time, so it is dead weight rather than a
    // bug — but keeping it out makes the file mean what it says.
    if (service && typeof service === "object" && "container_name" in service) {
      warn(id, `service "${name}" sets container_name; DeployKit removes it`);
    }
    if (service && typeof service === "object" && !service.image && !service.build) {
      fail(id, `service "${name}" has neither image nor build`);
    }
  }

  const declared = new Set(Object.keys(spec.variables ?? {}));

  // `variables` values call helpers; `${jwt:x}` names another variable.
  for (const [name, value] of Object.entries(spec.variables ?? {})) {
    for (const { name: helper, arg } of placeholdersIn(String(value))) {
      if (!HELPERS.has(helper)) {
        fail(id, `variable "${name}" calls unknown helper \${${helper}}`);
        continue;
      }
      if (helper === "jwt") {
        const secretName = (arg ?? "").split(":")[0];
        if (!secretName) fail(id, `variable "${name}": \${jwt:...} needs a secret variable name`);
        else if (!declared.has(secretName)) {
          fail(id, `variable "${name}": \${jwt:${secretName}} references an undeclared variable`);
        } else if (placeholdersIn(String(spec.variables[secretName])).some((p) => p.name === "jwt")) {
          fail(id, `variable "${name}": a jwt cannot be signed with another jwt`);
        }
      }
    }
  }

  // Everywhere else, a `${x}` names a declared variable.
  const substituted = [
    ...Object.entries(spec.env ?? {}).map(([k, v]) => [`env.${k}`, v]),
    ...(spec.domains ?? []).flatMap((d, i) => [
      [`domains[${i}].host`, d.host],
      ...(d.path ? [[`domains[${i}].path`, d.path]] : []),
    ]),
    ...(spec.mounts ?? []).flatMap((m, i) => [
      [`mounts[${i}].filePath`, m.filePath],
      [`mounts[${i}].content`, m.content],
    ]),
  ];

  for (const [where, value] of substituted) {
    for (const { name } of placeholdersIn(String(value))) {
      if (!declared.has(name)) {
        fail(id, `${where} references \${${name}}, which is not in "variables"`);
      }
    }
  }

  for (const [i, domain] of (spec.domains ?? []).entries()) {
    if (!serviceNames.includes(domain.service)) {
      fail(
        id,
        `domains[${i}] routes to service "${domain.service}", which the Compose file does not define (has: ${serviceNames.join(", ")})`,
      );
    }
  }

  // A `${FOO}` the Compose file reads but `env` never supplies becomes an
  // empty string: the container starts, misconfigured, instead of failing.
  const envKeys = new Set(Object.keys(spec.env ?? {}));
  for (const ref of composeRefs(compose)) {
    if (!envKeys.has(ref)) {
      fail(id, `docker-compose.yml interpolates \${${ref}}, which "env" does not supply`);
    }
  }

  const serialized = JSON.stringify(spec);
  if (/change[-_]?me/i.test(serialized)) {
    fail(id, "ships a placeholder credential; use a generator such as ${password:24}");
  }
  if (/"(?:password|secret|token|key)[^"]*"\s*:\s*"(?!\$\{)[^"]{6,}"/i.test(serialized)) {
    warn(id, "looks like it may contain a literal credential; check that secrets use generators");
  }

  metas.push({
    id: spec.id,
    name: spec.name,
    version: spec.version,
    description: spec.description,
    ...(spec.logo ? { logo: spec.logo } : {}),
    links: spec.links ?? {},
    tags: spec.tags ?? [],
  });
}

// index.json is what DeployKit fetches to render the catalogue; a stale one
// hides new blueprints from every install.
const indexPath = path.join(root, "index.json");
if (!existsSync(indexPath)) {
  problems.push("index.json is missing — run `npm run index`");
} else {
  const expected = JSON.stringify(metas, null, 2) + "\n";
  if (readFileSync(indexPath, "utf8") !== expected) {
    problems.push("index.json is out of date — run `npm run index` and commit the result");
  }
}

// A game definition (`games/<id>/game.json`) is checked against
// schema/game.schema.json, then against the cross-field rules of DeployKit's
// `gameSpecSchema` superRefine, which JSON Schema cannot express. Mirrored, not
// imported, for the same reason as HELPERS above.

const gamesDir = path.join(root, "games");
const gameSchemaPath = path.join(root, "schema", "game.schema.json");

/** `${dk_port_<name>}` is added per declared port. */
const GAME_BUILTINS = new Set(["dk_server_name", "dk_memory_mb", "dk_heap_mb"]);
// Only these are available inside mods.modpacks[].env.
const MODPACK_BUILTINS = [
  "dk_modpack_project",
  "dk_modpack_slug",
  "dk_modpack_version",
  "dk_modpack_game_version",
  "dk_modpack_loader",
];

const gameIds = existsSync(gamesDir)
  ? readdirSync(gamesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];
const gameMetas = [];

const isValidRegex = (source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

if (gameIds.length > 0) {
  const validateGame = ajv.compile(JSON.parse(readFileSync(gameSchemaPath, "utf8")));

  for (const id of gameIds) {
    const where = `games/${id}`;
    const dir = path.join(gamesDir, id);
    const specPath = path.join(dir, "game.json");

    if (!existsSync(specPath)) {
      fail(where, "missing game.json");
      continue;
    }

    let spec;
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (err) {
      fail(where, `game.json is not valid JSON — ${err.message}`);
      continue;
    }

    if (!validateGame(spec)) {
      for (const e of validateGame.errors ?? []) {
        fail(where, `game.json${e.instancePath} ${e.message}`);
      }
      continue;
    }

    if (spec.id !== id) {
      fail(where, `declares id "${spec.id}" but lives in games/${id}`);
      continue;
    }

    if (spec.logo) {
      const logoPath = path.join(dir, spec.logo);
      if (!existsSync(logoPath)) fail(where, `declares logo "${spec.logo}" but it is missing`);
      else if (statSync(logoPath).size > 100_000) warn(where, "logo is over 100 KB");
    }

    // The schema's defaults, which Ajv does not apply.
    const variables = spec.variables ?? [];
    const ports = spec.ports;
    const volumes = spec.volumes;
    const env = spec.env ?? {};
    const consoleMethod = spec.console?.method ?? "none";
    const backup = spec.backup ?? {};
    const stop = spec.stop ?? {};

    // Variables.
    const varKeys = new Set();
    for (const v of variables) {
      const at = `variables.${v.key}`;
      if (varKeys.has(v.key)) fail(where, `duplicate variable "${v.key}"`);
      if (v.key.startsWith("dk_")) fail(where, `${at}: the "dk_" prefix is reserved`);
      varKeys.add(v.key);

      if (v.type === "select") {
        if (!v.options) fail(where, `${at}: a select needs options`);
        else if (v.default !== undefined && !v.options.some((o) => o.value === String(v.default))) {
          fail(where, `${at}: default is not one of the options`);
        }
      } else if (v.options) {
        fail(where, `${at}: only a select may declare options`);
      }
      if (v.generator && v.type !== "string") fail(where, `${at}: only a string may have a generator`);
      if (v.default !== undefined) {
        const expected = v.type === "select" ? "string" : v.type;
        if (typeof v.default !== expected) fail(where, `${at}: default must be a ${expected}`);
      }
      if (v.pattern && !isValidRegex(v.pattern)) fail(where, `${at}: pattern is not a valid regex`);
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
        fail(where, `${at}: min is greater than max`);
      }
      // A definition never contains a secret: it is typed in or generated.
      if (v.secret && v.default !== undefined && v.default !== "") {
        fail(where, `${at}: a secret variable cannot ship a default; use a generator`);
      }
    }

    // Ports.
    const portNames = new Set();
    const portPairs = new Set();
    for (const p of ports) {
      if (portNames.has(p.name)) fail(where, `duplicate port "${p.name}"`);
      portNames.add(p.name);
      const pair = `${p.container}/${p.protocol}`;
      if (portPairs.has(pair)) fail(where, `duplicate port ${pair}`);
      portPairs.add(pair);
    }
    for (const p of ports) {
      if ((p.offsetOf === undefined) !== (p.offset === undefined)) {
        fail(where, `ports.${p.name}: offsetOf and offset go together`);
      }
      if (p.offsetOf !== undefined) {
        const base = ports.find((q) => q.name === p.offsetOf);
        if (!base || base.name === p.name) {
          fail(where, `ports.${p.name}: offsetOf names unknown port "${p.offsetOf}"`);
        } else if (base.offsetOf !== undefined) {
          fail(where, `ports.${p.name}: an offset port cannot follow another offset port`);
        }
      }
    }

    // `${name}` references in image, env and command.
    const known = new Set([
      ...varKeys,
      ...GAME_BUILTINS,
      ...[...portNames].map((n) => `dk_port_${n}`),
    ]);
    const substituted = [
      ["image", spec.image],
      ...Object.entries(env).map(([k, v]) => [`env.${k}`, v]),
      ...(spec.command ?? []).map((c, i) => [`command[${i}]`, c]),
    ];
    for (const [at, value] of substituted) {
      for (const { name, arg } of placeholdersIn(String(value))) {
        if (arg !== undefined) {
          fail(where, `${at}: \${${name}:${arg}} — helpers belong in a variable's "generator"`);
        } else if (!known.has(name)) {
          fail(where, `${at} references \${${name}}, which is not a declared variable or built-in`);
        }
      }
    }

    // Volumes.
    const volumeNames = new Set();
    for (const v of volumes) {
      if (volumeNames.has(v.name)) fail(where, `duplicate volume "${v.name}"`);
      volumeNames.add(v.name);
    }
    if (volumes.filter((v) => v.primary === true).length !== 1) {
      fail(where, "exactly one volume must be primary");
    }
    for (const f of spec.configFiles ?? []) {
      if (!volumeNames.has(f.volume)) {
        fail(where, `configFiles "${f.path}" is on unknown volume "${f.volume}"`);
      }
    }

    // Console.
    if (consoleMethod === "rcon") {
      const pw = variables.find((v) => v.key === spec.console.passwordVar);
      if (!pw) fail(where, `console.passwordVar "${spec.console.passwordVar}" is not a declared variable`);
      else if (!pw.secret) fail(where, "console.passwordVar must be a secret variable");
    }
    const needsConsole =
      (backup.preCommands ?? []).length > 0 ||
      (backup.postCommands ?? []).length > 0 ||
      stop.command !== undefined;
    if (needsConsole && consoleMethod === "none") {
      fail(where, "backup commands and stop.command need a console");
    }

    // Mods.
    if (spec.mods) {
      const mods = spec.mods;
      const sources = new Set();
      const modEnv = new Set();
      for (const s of mods.sources ?? []) {
        if (sources.has(s.source)) fail(where, `mods: duplicate source "${s.source}"`);
        sources.add(s.source);
        const steam = s.source === "steam-workshop";
        if (steam && s.appId === undefined) fail(where, "mods: steam-workshop needs appId");
        if (!steam && (s.appId !== undefined || s.enabledEnv !== undefined)) {
          fail(where, `mods: appId and enabledEnv are for steam-workshop only (${s.source})`);
        }
        if (s.apiKeyEnv !== undefined && s.source !== "curseforge") {
          fail(where, `mods: apiKeyEnv is for curseforge only (${s.source})`);
        }
        for (const name of [s.env, s.enabledEnv, s.apiKeyEnv].filter(Boolean)) {
          if (name in env) fail(where, `mods: ${name} is already set in env`);
          if (modEnv.has(name)) fail(where, `mods: ${name} is used twice`);
          modEnv.add(name);
        }
      }
      if (mods.loader) {
        const select = variables.find((v) => v.key === mods.loader.from);
        if (!select || select.type !== "select") {
          fail(where, "mods.loader.from must be a select variable");
        } else {
          for (const value of Object.keys(mods.loader.map ?? {})) {
            if (!select.options.some((o) => o.value === value)) {
              fail(where, `mods.loader.map: "${value}" is not an option of ${select.key}`);
            }
          }
        }
      }
      if (mods.gameVersion && !varKeys.has(mods.gameVersion.from)) {
        fail(where, "mods.gameVersion.from is not a declared variable");
      }
      const packSources = new Set();
      for (const p of mods.modpacks ?? []) {
        if (!sources.has(p.source)) fail(where, `mods.modpacks: "${p.source}" is not in sources`);
        if (p.source === "steam-workshop") fail(where, "mods.modpacks: the Workshop has no modpacks");
        if (packSources.has(p.source)) fail(where, `mods.modpacks: duplicate source "${p.source}"`);
        packSources.add(p.source);
        for (const [k, v] of Object.entries(p.env ?? {})) {
          for (const { name, arg } of placeholdersIn(String(v))) {
            if (arg !== undefined || !MODPACK_BUILTINS.includes(name)) {
              fail(where, `mods.modpacks.${p.source}.env.${k}: only \${dk_modpack_*} is available here`);
            }
          }
        }
      }
      for (const d of mods.directories ?? []) {
        if (!volumeNames.has(d.volume)) {
          fail(where, `mods.directories "${d.path}" is on unknown volume "${d.volume}"`);
        }
      }
    }

    const memory = spec.resources?.memoryMb;
    if (memory && memory.min > memory.recommended) {
      fail(where, "resources.memoryMb.min is greater than recommended");
    }
    if (spec.readyPattern && !isValidRegex(spec.readyPattern)) {
      fail(where, "readyPattern is not a valid regex");
    }

    if (/change[-_]?me/i.test(JSON.stringify(spec))) {
      fail(where, "ships a placeholder credential; use a generator such as ${password:24}");
    }

    gameMetas.push({
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
  }

  const gamesIndexPath = path.join(gamesDir, "index.json");
  if (!existsSync(gamesIndexPath)) {
    problems.push("games/index.json is missing — run `npm run index`");
  } else {
    const expected = JSON.stringify(gameMetas, null, 2) + "\n";
    if (readFileSync(gamesIndexPath, "utf8") !== expected) {
      problems.push("games/index.json is out of date — run `npm run index` and commit the result");
    }
  }
}

const summary = `${ids.length} blueprint(s) and ${gameIds.length} game(s)`;

for (const w of warnings) console.warn(`  warning  ${w}`);

if (problems.length > 0) {
  for (const p of problems) console.error(`  error    ${p}`);
  console.error(`\n${problems.length} problem(s) across ${summary}.`);
  process.exit(1);
}

console.log(
  `${summary} valid${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`,
);
