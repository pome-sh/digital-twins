# Contributing

Thanks for looking. This page says where a first contribution lands well, how the repository is built and tested, and what a pull request needs to carry.

## Where a first contribution lands well

In order of how little of the codebase you need to know:

1. **A seed.** A seed is the world a twin starts with: repositories and issues, channels and messages, customers and charges, mailboxes, projects. `pome twin new-seed <twin> --out seed.json` writes a starter you can edit; `pome twin start <twin> --seed seed.json` boots it. Bundled seeds live beside the tasks in [`cli/tasks/`](./cli/tasks/) as `<task>.seed.json`. A seed that sets up a scenario people keep needing (a pull request with a failing check, an incident channel with a thread, a subscription past due) is a contribution on its own.
2. **A showcase.** A showcase demonstrates one property of a twin with plain `curl` and a `verify.sh` that proves it. See [`showcases/`](./showcases/) for the two that exist and the shape they follow.
3. **A task.** A task is a graded scenario: a seed, an instruction for the agent, and checks. `pome tasks` lists the bundled ones; `pome checks <twin>` lists the checks a twin can grade. The authoring guide is in [`skills/`](./skills/).
4. **A route or a tool.** Each twin publishes a route-by-route fidelity record in its `FIDELITY.md`. A route at `shape` fidelity that you promote to `semantic` with a test against the vendor's documented behaviour, or a route at `unsupported` that the record marks as a promotion candidate, is a welcome change. Read the twin's `FIDELITY.md` first: some routes are `unsupported` on purpose, and the record says why.
5. **A new twin.** A twin is a package that satisfies the runtime contract in [`CONTRACT.md`](./CONTRACT.md). Open an issue before you start so we can agree on the vendor and the first slice.

Issues labelled [`good first issue`](https://github.com/pome-sh/digital-twins/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped to be done in one pull request.

## Building and testing

You need Node.js 24 or newer and npm.

```bash
npm ci
npm run build              # the CLI inlines every @pome-sh package; nothing runs from source without this
npx vitest run             # every package, then the CLI
npx vitest run --project cli
npm run lint               # the repository's own rules, not just style
npm run typecheck
```

Twin tests import the SDK from `packages/sdk/dist`, so after editing anything under `packages/sdk/src` run `npm run build -w packages/sdk` before the twin suites will see it. The end-to-end suites boot twins on real ports; another twin already listening on 3333, 3336, 3337 or 3401–3405 will make them fail in confusing ways, so check `pgrep -fl "twin start"` before chasing your own diff.

The map of packages is in [`packages/README.md`](./packages/README.md).

## What a pull request needs

- **A release note, in the same PR.** Every published package has a `CHANGELOG.md` beside its `package.json`. If your change touches a package's publish-relevant paths, add an entry under `## Unreleased (patch)` or `## Unreleased (minor)` at the top, saying what a consumer must do differently. A CI gate fails the PR without it, and fails any PR that edits a `version` field: the release pipeline writes version numbers, not people. Run the gate yourself:

  ```bash
  node scripts/ci/check-release-note-required.mjs "$(git merge-base HEAD origin/main)"
  ```

- **Every command you document, re-run.** If a README or a showcase says a command prints something, run it on the built CLI before you paste the output.
- **Tests for behaviour.** A twin route change carries a test against the vendor's documented behaviour; a CLI change carries a unit test, and an end-to-end test when it changes what a command prints or boots.
- **A title that is a sentence.** `The stripe twin accepts Stripe's []-append form encoding` beats `fix stripe encoding`.

Pull requests get an automated review from Greptile a few minutes after CI starts. Its findings have been worth reading; answer each one on its thread.

## Reporting a bug

The most useful bug report carries the tape. With the twin still running, in the folder you started it from:

```bash
pome twin tape --json > tape.json
```

Attach `tape.json` (it holds request paths, status codes and the twin's fidelity marks; the bearer is redacted by the recorder) together with `pome --version`, your OS, and what you expected. The [bug report template](./.github/ISSUE_TEMPLATE/bug.md) asks for the rest.

Security problems go to [`SECURITY.md`](./SECURITY.md), not to a public issue.

## Licence

This repository is Apache-2.0. By contributing you agree that your contribution is licensed the same way.
