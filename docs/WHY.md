# Why architecture diagrams as text

Proschi is a small text language for architecture diagrams and high-level
designs. You write the services, stores and queues and the requests between
them. Proschi lays out the diagram, plays each request step by step, and
checks the design against the traffic and requirements you write beside it.

```proschi
title "Notes"

user "User"      [Actor]
api  "Notes API" [REST API]   @backend
db   "Notes DB"  [PostgreSQL] @backend

user -> api : HTTPS
api  -> db  : SQL

usecase "Create a note" {
  user -> api : POST /notes json {"text": "Buy milk"}
  alt "Saved" {
    api  -> db   : INSERT note
    api --> user : 201 {"id": 42}
  } alt "DB down" {
    api  -x db   : INSERT note
    api --> user : 503
  }
}
```

> **Try it:** pick **Create a note › DB down** and press **Play**. The
> insert fails at the database and the user gets a `503`.

## Why text

- **It diffs.** A design is a file next to the code, reviewed in pull
  requests like the code. No exported PNG that drifts from the system.
- **It lays itself out.** You never drag a box. Add a line and the diagram
  follows. Pin a node with `pos` only when you want to.
- **It plays.** A use case is a real request: each step names its endpoint,
  payload and status, and `alt` keeps the success path and every failure
  side by side.
- **It checks itself.** With `traffic` and `requirements`, a deterministic
  simulation says which node saturates first, what p99 to expect, whether
  the design survives a node failure and what it costs.
- **It runs in your browser.** The editor parses, lays out and simulates
  locally. Signed out, your diagrams stay in the browser and in the links
  you share. Signing in adds cloud sync (see [Privacy](PRIVACY.md)).

## When it fits

Proschi fits a design you want to review, play and check before you build
it: a new service, a system design interview, a team's slice of a larger
system. It is not a free-form drawing tool: every box is a node the
simulation counts. And the simulation estimates from default numbers per
tech stack, so it compares designs rather than measuring yours. [How the simulation works](https://proschi.app/docs/model/)
says how far to trust its numbers.

Start with the [Quickstart](QUICKSTART.md). Proschi is free and open source
under the MIT license, on [GitHub](https://github.com/gvart/proschi).
