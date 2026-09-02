# Task format

A Pome task is one Markdown file. The CLI parser in `cli/src/task/parseTask.ts` defines local parsing. Hosted authoring adds the requirements below.

## Use the format

1. Create a Markdown file in the task directory from your Pome manifest.
2. Add a prompt and at least one success criterion.
3. For hosted authoring, add `## Config` and set `twins`.
4. Add seed state only when the task needs a nondefault starting state.
5. Run `pome checks lint <task-file>`.

## Title

The parser uses the first line that starts with one `#` and one space.

```markdown
# Triage the payment failure
```

If no such line exists, the parser uses the file name as the task slug and title.

## Sections

The parser recognizes these level-two headings without case sensitivity:

| Heading | Alias | Required | Purpose |
| --- | --- | --- | --- |
| `## Prompt` | `## Task` | Yes | Instruction sent to the agent. |
| `## Success Criteria` | `## Checks` | Yes | One or more graded criteria. |
| `## Setup` | None | No | Hosted runs show this context to the examinee. The current local CLI does not send it. |
| `## Expected Behavior` | None | No | Evaluator context. The runner does not send it to the agent. |
| `## Config` | None | Hosted: Yes. Local CLI: No. | Task configuration. The local CLI uses GitHub defaults when absent. |
| `## Seed State` | None | No | Initial twin state. Twin defaults apply when absent. |

An unrecognized level-two section is ignored. A level-three heading remains inside its current section.

Do not start a line with `## ` inside a fenced block. The parser will treat that line as a section.

## Criteria

Write one criterion on each bullet line:

```text
- [code] <declared check sentence>
- [model] <observable behavior for the judge>
- [code:github] <declared GitHub check sentence>
- [code:slack always-scored] <declared Slack check sentence>
```

The marker grammar is:

```
/^[-*]\s+\[(code|model)(?::([a-z][a-z0-9_-]*))?(\s+always-scored)?\]\s+(.+)$/
```

Use lowercase `code` and `model`.

Only lines that match this grammar become criteria.
The parser reports some malformed markers, but other nonmatching lines remain prose.

### Code criteria

A `[code]` criterion must match a check declared by its twin.

List current checks:

```bash
pome checks
pome checks github
pome checks gmail
pome checks linear
pome checks slack
pome checks stripe
```

All five current twins declare checks. Do not rely on a copied list of check phrases.

Add a criterion from a declaration:

```bash
pome checks add tasks/my-task.md \
  --check github.issue-assignee \
  --arg issue=1 \
  --arg repo=acme/api \
  --arg login=alice
```

Check all local bindings:

```bash
pome checks lint tasks/*.md
```

`pome checks lint` reads the declarations bundled with the CLI. It exits `1` when a criterion does not bind.

### Twin tags

For a single-twin task, a tag is optional. If present, the tag must match that twin.

For a multi-twin task, every `[code]` criterion needs a twin tag. The tag must name a configured twin.

A `[model]` criterion can omit the tag. An untagged criterion uses the first configured twin for attribution.

### `always-scored`

The hosted grader normally excludes a `[code]` criterion that the seed already satisfies.

Use `always-scored` when the agent must preserve that state. This form supports restraint and adversarial tasks.

```markdown
- [code:slack always-scored] No secret was newly exposed in a public channel
```

Use `always-scored` only with `[code]`. The parser rejects it on a `[model]` criterion.

Do not add this keyword to hide an accidental pre-satisfied positive criterion. Correct that seed or criterion.

## Config

Hosted authoring requires this section and an explicit `twins` value. The current local CLI can omit the section and default to GitHub.

Put configuration in a fenced YAML block:

```yaml
twins: [github]
class: adversarial
timeout: 120
runs: 3
passThreshold: 100
```

| Key | Type | Default | Constraint |
| --- | --- | --- | --- |
| `twins` | String array | Local CLI: `["github"]`. Hosted authoring: none. | Use one or more mounted twin identifiers. |
| `class` | String | None | `conformance`, `restraint`, or `adversarial`. |
| `timeout` | Integer | `60` | Positive number of seconds. |
| `runs` | Integer | `1` | Positive trial count. The hosted CLI uses at most 20 trials. |
| `passThreshold` | Number | `100` | Value from `0` through `100`. |

You can write `pass_threshold` instead of `passThreshold`. If both exist, `passThreshold` takes precedence.

The parser removes unknown configuration keys. Check spelling before you run the task.

The mounted twin identifiers are `github`, `gmail`, `linear`, `slack`, and `stripe`.

## Seed state

The CLI can read seed state from either location:

- A JSON value in `## Seed State`.
- A sibling `<task-name>.seed.json` file.

The sidecar file takes precedence when both locations exist. The parser removes sidecar `_meta` blocks before seed validation.

Hosted `validate_task` and `save_task` receive only the task source. Inline the JSON before you publish a task to the hosted catalog.

If neither location supplies a seed, each configured twin uses its default seed.

### Inline JSON

Put one JSON object in the section:

````markdown
## Seed State
```json
{
  "repositories": []
}
```
````

The contents must be JSON. A YAML fence does not make YAML seed data valid.

### Prose seed and sidecar

A prose `## Seed State` section requires a sibling sidecar file.

For a single-twin GitHub task, you can compile the sidecar:

```bash
export ANTHROPIC_API_KEY='<key>'
pome compile-seeds tasks/my-task.md
```

`pome compile-seeds` currently supports only single-twin GitHub tasks. It skips other twins and multi-twin tasks.

The command also skips inline JSON. It does not overwrite a sidecar marked as hand-authored.

### Single-twin shape

Use the selected twin's flat seed object. Do not wrap it with the twin identifier.

```json
{
  "users": [],
  "repositories": [
    { "owner": "acme", "name": "api" }
  ]
}
```

### Multi-twin shape

Use an object that maps each configured twin to its flat seed:

```json
{
  "github": {
    "users": [],
    "repositories": [
      { "owner": "acme", "name": "api" }
    ]
  },
  "slack": {
    "users": [],
    "channels": []
  }
}
```

Envelope keys must be configured twin identifiers. You can omit a configured twin to use its default seed.

Do not use an envelope for a single-twin task. Do not use a flat seed for a multi-twin task.

## Current seed schemas

Current local seed schemas reject unknown top-level keys and unknown keys in defined entity objects.

Hosted Gmail and Linear seeds also reject unknown keys. The hosted GitHub, Slack, and Stripe parsers currently drop unknown keys. Check parsed collections after hosted validation so a misspelled key does not remove state.

Explicit map and payload fields can accept arbitrary keys. Examples include Slack profiles and failure-response bodies.

### GitHub

Top-level fields:

- `users`, optional with an empty-array default.
- `repositories`, required and nonempty after parsing.

A repository supports collaborators, labels, files, milestones, tags, releases, issues, and pull requests.

Issue and pull-request numbers share one repository sequence. Do not assign the same number to both entity types.

A pull request needs a `head` branch. Seed a file on that branch when the branch does not otherwise exist.

For compatibility, the parser converts an issue's singular `assignee` string to the `assignees` array.

### Slack

Top-level fields:

- `team`
- `users`
- `channels`
- `files`
- `emoji`

All fields have defaults. An empty object is valid and expands to the Slack schema defaults during parsing.

Channel names must use lowercase letters, digits, underscores, or hyphens. A message must identify its user.

### Stripe

Top-level fields:

- `api_keys`
- `failure_injection`
- `payment_intents`
- `charges`
- `refunds`
- `balance_transactions`

All fields have empty-array defaults. These are the only accepted top-level Stripe seed fields.

### Gmail

Top-level fields:

- `primaryMailbox`, required.
- `mailboxes`, optional.
- `deliveryMode`, optional.
- `clock`, optional.
- `faults`, optional.

Mailbox entries can contain labels, messages, drafts, filters, forwarding addresses, and send-as identities.

Email addresses are normalized to lowercase. Mailbox addresses must be unique.

### Linear

Top-level fields:

- `clock`, `defaultSid`, `baseUrl`, and `strictScopes`.
- `organization`, `users`, `teams`, `labels`, `projects`, and `cycles`.
- `issues`, `comments`, and `documents`.
- `oauthApps`, `tokens`, and `webhooks`.

Linear validates references between issues, teams, users, labels, projects, cycles, and comments.

Team keys must start with an uppercase letter. Team keys can then contain uppercase letters and digits.

## Default seeds

- GitHub uses `acme/api`, four users, three labels, two files, and one open issue.
- Slack task defaults contain default team fields and empty user, channel, file, and emoji arrays.
- Stripe uses one test API key and empty resource collections.
- Gmail uses the Pome agent mailbox with messages, labels, an attachment, and a draft.
- Linear uses an engineering workspace with users, workflow states, labels, projects, issues, and comments.

Use an explicit seed when your prompt depends on state that is not part of these defaults.

## Complete example

This task uses the default GitHub seed:

````markdown
# Assign the deployment issue

## Prompt
Assign issue #1 in `acme/api` to `alice`.

## Success Criteria
- [code] Issue #1 in `acme/api` is assigned to `alice`

## Config
```yaml
twins: [github]
timeout: 120
```
````
