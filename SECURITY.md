# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Preferred: [open a private vulnerability report](https://github.com/pome-sh/digital-twins/security/advisories/new) on this repository. Only the maintainers can see it.
- Email: founders@pome.sh.

Tell us what you found, how to reproduce it, and which version (`pome --version`) or commit. We acknowledge every report, work on a fix in private, and credit you in the release note if you want to be named. There is no bounty programme.

## What is in scope

- The `@pome-sh/cli` package: the `pome` command and the twin runtimes it bundles.
- The twin runtime contract in [`CONTRACT.md`](./CONTRACT.md): bearer authentication, the admin gate, the boot secret, session isolation, the tape and the state export.
- The published npm artifacts and the release workflow that produces them.

The agent examples, showcases and skills in this repository are samples. A problem in one of them is still worth a report, but it is not a vulnerability in the product.

## What the twins are, and are not

A twin is a local, stateful stand-in for a vendor API, bound to loopback by default. It is a test fixture, not a service to expose on a network. The security model that matters is the one in `CONTRACT.md`: every session route requires a bearer minted from `TWIN_AUTH_SECRET`, the admin routes refuse callers they cannot identify, and a twin never serves the public dev secret unless you opt in with `POME_ALLOW_DEV_SECRETS=1`. If you find a way around any of that, report it.

Seeds and tapes can contain data you put there. Treat `.pome/`, `.pome-data/` and any tape you export the way you treat credentials.

## Supported versions

The latest version published to npm. Fixes ship as a new release rather than as patches to older versions.
