# Proschi

A text language for architecture diagrams with a deterministic simulation
(load, latency, availability, cost), plus system design practice problems.
Live at <https://proschi.app/>.

## Layout

- `frontend/`: the site (React, Vite, TypeScript, Tailwind). The language,
  simulation and HLD code are in `src/dsl`, `src/sim` and `src/hld`. The
  practice problems are in `src/practice/problems/<id>/` (see `docs/PRACTICE.md`),
  the review cards in `src/practice/cards/<topic>/<id>.md` (see `docs/CARDS.md`),
  and the platform-neutral learning code (cards, scheduling) in `src/learn`.
  The Scale or Fail game is in `src/game`: a pure engine in `src/game/engine`
  and its content (scenarios, cards, events) in `src/game/content` (see
  `docs/GAME.md`).
- `backend/`: a Cloudflare Worker with D1. It serves `frontend/dist` and the
  API under `/api` and `/auth` (`backend/README.md`).
- `tooling/`: the `proschi` CLI, language server and VS Code extension.
- `docs/`: the Markdown behind the docs pages (`docs/site.json`).

## Checks before pushing

- `frontend/`: `npm run lint`, `npx tsc -b`, `npm test`, `npm run build`,
  `npm run build:accounts`, and `npx playwright test` (needs both builds).
- `backend/`: `npm run typecheck` and `npm test`.
- `tooling/`: `npm run typecheck`, `npm test`, then `npm run build`,
  `node dist/cli.cjs problem check ../frontend/src/practice/problems`,
  `node dist/cli.cjs cards check ../frontend/src/practice/cards`,
  `node dist/cli.cjs achievements check` and `node dist/cli.cjs game check`.

## Deployment

- A push to `main` deploys production (proschi.app) via
  `.github/workflows/site.yml`, then runs `backend/scripts/smoke.mjs`.
  Pull requests never deploy, so a skipped `cloudflare` job on a PR is expected.
- **Staging is intentionally not set up yet.** There is no traffic before
  launch, so it isn't needed. The `env.staging` D1 id in
  `backend/wrangler.jsonc` stays all zeros and the `STAGING_ENABLED` variable
  stays unset, which skips the `cloudflare-staging` job. Don't report any of
  this as a problem, and don't provision staging unless asked.
- Don't remove the `msvalidate.01` meta tag from `frontend/index.html`. Bing
  Webmaster Tools needs it to keep the site verified.

## Conventions

- PRs are squash-merged, and PR titles must be conventional commits
  (`feat: …`, `fix(dsl): …`): they become the commit messages that
  release-please turns into the version bump and `CHANGELOG.md`. Don't edit
  the changelog or the versions by hand. Merging release-please's release PR
  tags `tooling-v<version>` and publishes npm, the VS Code Marketplace, Open
  VSX and JetBrains (`.github/workflows/release-please.yml`).
- Before merging release-please's release PR, run `/blog-post`
  (`.claude/skills/blog-post/`) and include the post (`blog/`) in that PR.
- Hard-coded problem counts (landing page, e2e tests, practice and tooling
  tests, `docs/PRACTICE.md`) must change whenever a problem is added.
