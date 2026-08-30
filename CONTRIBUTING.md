# Contributing a blueprint

## Setup

```bash
npm install --no-package-lock
```

Three dev dependencies (ajv, ajv-formats, yaml) — the catalogue itself ships no
code.

## Add a blueprint

1. Create `blueprints/<id>/`. The id is lowercase with hyphens, and it must
   match the `id` in `template.json`. It is the URL segment DeployKit fetches,
   so pick something stable — renaming it breaks the link for existing installs.

2. Write `docker-compose.yml`. Plain Compose, with a few rules:

   - **Pin image tags.** `postgres:16-alpine`, never `postgres:latest` — a
     catalogue entry that silently changes major version under people is worse
     than no entry.
   - **No `container_name`.** DeployKit strips it; two deployments of the same
     blueprint would collide.
   - **No Traefik labels.** Declare `domains` in `template.json` instead.
   - **Named volumes for anything that must survive a redeploy.**
   - **Read config through `${VAR}`**, and supply every one of those from `env`
     in `template.json`. An unsupplied variable becomes an empty string and the
     container starts misconfigured instead of failing.

3. Write `template.json`. Start with `"$schema": "../../schema/template.schema.json"`
   so your editor validates it as you type. See the
   [README](README.md#templatejson) for the format and the helper list.

   Every credential must use a generator — `${password:24}`, `${base64:64}`.
   Never a literal.

4. Add `logo.svg`: 24×24 viewBox, transparent background, a single brand colour.
   Check it stays legible on `#1a1a25`, DeployKit's card background.

5. Regenerate and check:

   ```bash
   npm test
   ```

## What the validator checks

`scripts/validate.mjs` is the same contract DeployKit applies before it deploys
anything, so passing here means it will resolve on a real server:

- `template.json` matches the schema, and its `id` matches the directory
- the declared logo exists
- `docker-compose.yml` parses and every service has an `image` or `build`
- every `domains[].service` is a service the Compose file actually defines
- every `${VAR}` the Compose file interpolates is supplied by `env`
- every `${x}` in `env` / `domains` / `mounts` is declared in `variables`
- every `${helper}` in `variables` is one DeployKit implements
- no literal placeholder credentials
- `index.json` is up to date

## Test it for real

The validator cannot tell you the stack actually works. Before opening a pull
request, deploy it: on a DeployKit install, **Templates → your blueprint**, or
locally with

```bash
cd blueprints/<id>
docker compose up -d
```

after writing a `.env` with the keys your `env` block declares.

Say in the pull request what you tested it on.

## Updating an existing blueprint

Bump `version` to the upstream version you tested. Installs pick up the change
within an hour; existing stacks are untouched until their owner redeploys.

Changing `variables` or `env` only affects new deployments — an existing stack
keeps the values it was created with.
