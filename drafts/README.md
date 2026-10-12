# Drafts

Definitions that are finished but must not be published yet. Nothing here is
indexed or served; move a directory into `games/` (fix its `$schema` path) and
run `npm test` to publish it.

- `games/terraria-tmodloader` — waits for `jacobsmile/tmodloader1.4` to ship
  libicu again: every tag checked (v2026.05.3.0 … v2026.09.2.1, Ubuntu 26.04)
  aborts at start with "Couldn't find a valid ICU package". With ICU present
  the definition was verified: Workshop downloads, `enabled.json`, the `exec`
  console (`inject`) and save-on-SIGTERM all work.
