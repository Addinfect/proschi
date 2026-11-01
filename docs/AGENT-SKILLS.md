# Agent skills

Proschi ships skills for AI coding agents: Claude Code, Codex, Cursor,
GitHub Copilot, Gemini CLI and any agent that reads instruction files. With
them, an agent turns your repository into a Proschi model, checks it with
the [`proschi` CLI](EDITORS.md#install), and gives you an editor link.

The skills live in the
[Proschi repository](https://github.com/gvart/proschi/tree/main/plugin/skills)
in the open [Agent Skills](https://agentskills.io) format: one folder per
skill, with its instructions and a cheat sheet of the
[language](LANGUAGE.md).

## Pick a skill

| Skill | What it does |
|---|---|
| `infra-to-proschi` | Models an existing system from prose, a README, Mermaid, Terraform, CloudFormation, CDK, Kubernetes, Helm or docker-compose. Guesses are marked as comments. |
| `image-to-proschi` | Recreates a screenshot or photo of an architecture diagram (draw.io, Lucidchart, Miro, a whiteboard), legend included. |
| `code-to-usecases` | Writes `usecase` blocks from HTTP routes, gRPC services, consumers and client calls, with `par` and `alt` failures. |
| `proschi-capacity-plan` | Adds `traffic`, `requirements` and replicas from SLOs or expected load, and fixes the bottlenecks `proschi analyze` finds. |
| `proschi-design-review` | Reviews a design for single points of failure, saturation, missing failure scenarios and cost waste, with concrete edits. |
| `proschi-keep-in-sync` | Finds architecture drift in a pull request and updates the `.proschi` files. Suggests the [GitHub Action](EDITORS.md#github-action). |
| `proschi-hld-doc` | Fills in the model and generates the [HLD document](EDITORS.md#hld-documents) with `proschi render --format hld-md`. |

Every skill ends the same way: `npx proschi check` and `npx proschi test`
until clean, a look at the rendered diagram (`npx proschi render`), then
`npx proschi share-link <file>`. The skills need Node 18 or newer, and
`share-link` and `import` need `proschi` 0.9 or newer.

## Install the skills

| Agent | Install | Then |
|---|---|---|
| Claude Code | `/plugin marketplace add gvart/proschi`, then `/plugin install proschi@proschi` | Nothing. `/plugin marketplace update proschi` fetches new versions. |
| Claude Code, without the plugin | `npx degit --force gvart/proschi/plugin/skills .claude/skills` (or `~/.claude/skills` for every project) | Commit `.claude/skills/` to share them with your team. |
| Codex, and any agent that reads `AGENTS.md` | `npx degit gvart/proschi/plugin/skills .agents/skills` | Add the line below to `AGENTS.md`. |
| Cursor | the same `degit` command | Add the line to `.cursor/rules/proschi.mdc`, with front matter `description: Proschi architecture diagrams`. Cursor reads `AGENTS.md` too. |
| GitHub Copilot | the same `degit` command | Add the line to `.github/copilot-instructions.md`. |
| Gemini CLI | the same `degit` command | Add the line to `GEMINI.md`, or import one skill: `@.agents/skills/infra-to-proschi/SKILL.md`. |

The line tells the agent where the skills are:

```text
For architecture diagrams (.proschi files), follow the matching skill in .agents/skills/*/SKILL.md.
```

Agents with native Agent Skills support need no line. Without `degit`:

```sh
git clone --depth 1 https://github.com/gvart/proschi /tmp/proschi
cp -R /tmp/proschi/plugin/skills .agents/skills
```

In Claude Code, a skill runs when a task matches (*"diagram our
docker-compose in Proschi"*), or you call it directly:
`/proschi:infra-to-proschi`.

## What to ask

- *"Model our infrastructure from `deploy/` and `docker-compose.yml` in Proschi."*
- *"Recreate `docs/architecture.png` in Proschi, with its legend."*
- *"Write Proschi use cases for the checkout endpoints, including the failure paths."*
- *"We expect 5k rps on search with a p99 under 200 ms: size the design."*
- *"Review `docs/architecture.proschi` before the design review."*
- *"This PR adds a notification service: update the diagrams."*

## How the skills lay out a diagram

The layout runs top-down along the connections and keeps the declaration
order. So the skills point every connection from caller to callee, declare
tier by tier, group by a real boundary (network, cluster, team), and render
the diagram to fix crossings before handing it over. See
[steering the layout](STYLING.md#steering-the-layout) for `layout ordered`,
`rank` and `direction`.

## Diagrams in the terminal

The Claude Code plugin also draws Proschi diagrams in Claude Code's
terminal, with the same layout as the browser. It draws:

- a ```` ```proschi ```` block in Claude's reply (the plugin tells Claude to
  answer with one instead of Mermaid or ASCII art when it shows an
  architecture or a request flow);
- a `.proschi` file Claude writes or edits, under the tool call;
- a file you name with `/proschi view <file>`, in a pane that redraws when
  the file changes.

A drawing shows the cards, groups, legend and, with `traffic`, the load on
each node. Under it, a use case picker opens a player like the editor's.
Buttons copy the source or a share link, open the diagram in Proschi, or,
with **⛶ Focus**, move it into a pane you drive from the keyboard:

| Key | Does |
|---|---|
| `p` | Play or pause |
| `n` / `b` | Next or previous step |
| `r` / `e` | Restart, or jump to the end |
| `x` | Show or hide the use case explorer |
| `d` | Back to the diagram |
| `s` / `o` | Select the next [team system](SYSTEMS.md), open or close it in place |
| `f` / `u` | Draw only the selected system's design, go back out |
| `Esc` | Close the pane, back to the prompt |

`ctrl+x tab` moves focus to the pane when it doesn't have it.
`/proschi view --expand orders org.proschi` starts with Orders open, and
`--focus orders` starts inside it.

It needs a Claude Code build with mod support and Node 18 or newer on the
`PATH`. Icons are [Nerd Font](https://www.nerdfonts.com) glyphs; without
one, set the plugin's `icons` option to `symbols` or `none`.

Limits:

- The plugin never uses the network. Remote imports come from the cache
  that [`proschi imports sync`](IMPORTS.md#syncing-remote-imports) fills.
- It checks import paths as text and cannot resolve symlinks, so it follows
  a symlink inside the project that points outside it. `proschi check`
  resolves symlinks and reports that import.
- It draws in a terminal only, fitted to its width (40 to 512 columns).
- The drawing is read-only. Edit the source, or open it in the editor.
