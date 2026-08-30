# DeployKit templates

One-click blueprints for [DeployKit](https://github.com/deploykithq/deploykit).

This repository is the catalogue. DeployKit does not ship blueprints inside its
image — every install fetches them from here at runtime, so a blueprint merged
here shows up in the Templates page of every install within an hour, with no
DeployKit release and no upgrade.

It also means a broken blueprint on `main` is broken for everyone, which is why
CI validates every one of them on each pull request.

## What a blueprint is

A directory under `blueprints/`, named after the template id:

```
blueprints/plausible/
├── docker-compose.yml   the stack itself, plain Compose
├── template.json        metadata, generated variables, routing, env, config files
└── logo.svg             24×24, shown on the catalogue card
```

`docker-compose.yml` is an ordinary Compose file. DeployKit does not rewrite it
on disk — at deploy time it injects ownership labels, the Traefik routing labels
for whatever `template.json` declares in `domains`, and the shared network.

## template.json

```jsonc
{
  "$schema": "../../schema/template.schema.json",
  "id": "plausible",
  "name": "Plausible",
  "version": "v2.1.5",
  "description": "Privacy-friendly, self-hosted web analytics.",
  "logo": "logo.svg",
  "links": {
    "github": "https://github.com/plausible/analytics",
    "website": "https://plausible.io",
    "docs": "https://plausible.io/docs"
  },
  "tags": ["analytics"],

  // Derived once per deployment. Never a literal secret.
  "variables": {
    "main_domain": "${domain}",
    "secret_key_base": "${base64:64}",
    "db_password": "${password:24}"
  },

  // Which service Traefik routes a hostname to.
  "domains": [{ "service": "plausible", "port": 8000, "host": "${main_domain}" }],

  // Written to the .env file Compose reads next to docker-compose.yml.
  "env": {
    "BASE_URL": "https://${main_domain}",
    "SECRET_KEY_BASE": "${secret_key_base}",
    "DB_PASSWORD": "${db_password}"
  },

  // Config files the stack bind-mounts.
  "mounts": [{ "filePath": "clickhouse.xml", "content": "<clickhouse>…</clickhouse>" }]
}
```

The `$schema` line is what makes an editor validate the file as you type. It is
ignored at runtime.

### A blueprint never contains a secret

It declares how one is derived. DeployKit generates a fresh value per
deployment with `crypto.randomBytes`, shows it to the user once, and stores it
encrypted. A literal `change-me` password fails validation.

| Helper | Produces |
|---|---|
| `${domain}` | The hostname for this deployment — the user's, or a generated one |
| `${password:N}` | N alphanumeric characters |
| `${base64:N}` | N random bytes, base64 |
| `${hash:N}` | N random bytes, hex |
| `${uuid}` | A UUID v4 |
| `${randomPort}` | A free host port in 20000–65000 |
| `${username}` | A random readable slug |
| `${email}` | `<slug>@<domain>` |
| `${timestamp}` | The current ISO 8601 timestamp |
| `${jwt:<var>[:<role>]}` | A JWT signed with another variable's value |

`${jwt:...}` resolves in a second pass, so it can reference a variable declared
anywhere in the file — but it can only be signed with a value produced by
another helper, never by another jwt.

### Two different `${}` syntaxes

This is the one thing worth reading twice.

- **In `template.json`**, `${...}` is DeployKit's generator syntax. Inside
  `variables` it calls a helper; inside `env`, `domains` and `mounts` it
  substitutes a variable declared in `variables`.
- **In `docker-compose.yml`**, `${...}` is *Compose's own* interpolation.
  DeployKit writes the resolved `env` to a `.env` file next to the Compose
  file, and Compose reads it. Write `${DB_PASSWORD}` there, matching a key of
  `env` — never `${db_password}`, the variable name.

Use `$${` for a literal `${` in either file.

### Routing

Declare a `domains` entry and DeployKit adds the Traefik labels, the shared
network, an HTTPS router with a Let's Encrypt certificate, and an HTTP→HTTPS
redirect. Don't write Traefik labels yourself, and don't publish a host port for
a routed service — DeployKit turns `ports` into `expose` for those.

A stack with no web UI (a database, say) gets no shared network, so if it needs
to be reachable from outside it should publish a `${randomPort}` host port.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

```bash
npm install --no-package-lock
# add blueprints/<your-template>/
npm test          # rebuilds index.json and validates everything
```

## Generated files

Two files are generated; do not hand-edit either.

- **`index.json`** — the catalogue listing DeployKit fetches, so it can render
  cards without pulling every blueprint. Run `npm run index` and commit the
  result; CI fails if it is stale.
- **`schema/template.schema.json`** — the blueprint contract. It is derived from
  DeployKit's own Zod schema so there is exactly one definition of what a
  blueprint is, and it is re-emitted from that repository with
  `pnpm --filter @deploykit/shared schema:emit -- --out <here>/schema/template.schema.json`
  whenever the format changes.

## Logos

Blueprint logos are 24×24 SVGs with a transparent background, drawn in the
project's brand colour, lightened where necessary to stay legible on DeployKit's
dark UI.

Most come from [simple-icons](https://simpleicons.org) (the SVG files are CC0).
Trademarks belong to their respective owners and are used here only to identify
the software each blueprint deploys. Where simple-icons has no entry, the
blueprint carries a DeployKit lettermark instead — a pull request replacing one
with the project's official mark is welcome.

## Licence

MIT, matching DeployKit. See [LICENSE](LICENSE).
