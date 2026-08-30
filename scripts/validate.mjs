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

for (const w of warnings) console.warn(`  warning  ${w}`);

if (problems.length > 0) {
  for (const p of problems) console.error(`  error    ${p}`);
  console.error(`\n${problems.length} problem(s) across ${ids.length} blueprint(s).`);
  process.exit(1);
}

console.log(
  `${ids.length} blueprint(s) valid${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`,
);
