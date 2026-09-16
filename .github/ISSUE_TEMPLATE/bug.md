---
name: Bug report
about: Something doesn't work the way the docs say it should.
title: "[bug] "
labels: bug
---

<!--
Security issues: do NOT file here. See SECURITY.md (private report on GitHub, or founders@pome.sh).
-->

## What happened

<!-- A clear, concise description of the bug. -->

## What you expected to happen

<!-- What should have happened instead. -->

## Reproduction

<!--
Minimal steps. Code snippets, commands, or a link to a small repo are best.
1.
2.
3.
-->

## Environment

- Pome component: <!-- cli / twin-github / wire / twin start -->
- Version or image digest: <!-- `pome --version`, image sha256, or commit SHA -->
- OS / arch: <!-- e.g. macOS 14 arm64, Ubuntu 22.04 x86_64 -->
- Node.js / npm version (if relevant):

## Tape

<!--
With the twin still running, in the folder you started it from:
  pome twin tape --json > tape.json
Attach tape.json. It carries request paths, status codes and fidelity marks;
the bearer is redacted by the recorder.
-->

## Logs

<details>
<summary>Relevant logs / stack traces</summary>

```
paste here
```

</details>

## Anything else

<!-- Workarounds you tried, related issues, hunches. Optional. -->
