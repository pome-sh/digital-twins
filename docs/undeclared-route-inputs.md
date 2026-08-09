# What each twin does with an undeclared route input

F-1179 gave every twin one answer to "an agent sent a query parameter this
route's declaration does not name": refuse it, 4xx. That answer was a default
nobody had measured — its PR escalated the question and ended "Please rule",
and no ruling came, so the strict side landed.

F-1372 measured the vendors instead. They disagree, so the answer is now the
twin's, declared once at the top of each `packages/twin-*/src/route-inputs.ts`
through `routeInputDeclarer()`. This page is the evidence behind each of those
five lines.

## The ruling

| Twin | Disposition | Grade | What decided it |
| --- | --- | --- | --- |
| `twin-github` | `ignore` | measured | 10 live surfaces returned byte-identical answers with and without an unknown query key; `POST /markdown` did the same for an unknown body key |
| `twin-slack` | `ignore` | measured | `api.test` returned `ok:true` and echoed the unknown argument, as a GET query key and as a POST form field |
| `twin-gmail` | `refuse` | published | Google's gRPC transcoder answers 400 `INVALID_ARGUMENT` to a query parameter that binds to no request-message field |
| `twin-stripe` | `refuse` | published | Stripe publishes `parameter_unknown`: "The request contains one or more unexpected parameters. Remove these and try again." |
| `twin-linear` | `ignore` | measured | RFC 6749 §3.1 **and** §3.2 make ignoring mandatory for four of its six routes, and live Linear answered identically with and without an unknown parameter on OAuth and on `/graphql` |

"Measured" means a request was sent to the vendor's production API on
2026-08-09 and the answer is transcribed below. "Published" means the vendor
documents the behaviour but the live probe could not reach it, for the reason
recorded per twin.

Three of the five ignore, two refuse — which is the finding, and the reason a
single default for all five was never going to be right. Note also that it does
not fall out along "strict vendor / lax vendor" lines the way one might guess:
Stripe and Google are strict about parameter names and GitHub, Slack and Linear
are not, but all five are equally strict about the VALUES of the parameters they
do know, and that half is unchanged here.

## Why the disposition is a fidelity setting and not a policy

A twin exists so that an agent written against the vendor runs unchanged
against the twin, and so that an exam scores the agent rather than the double.
Both directions of getting this wrong cost something, and they are not
symmetric:

- **Refusing where the vendor accepts** fails an agent that did nothing wrong.
  It is [F-1330](https://linear.app/pome-sh/issue/F-1330)'s shape one layer
  down: the twin invents a rule, the agent trips over it, the report says the
  agent failed. On `twin-linear`'s OAuth routes it was worse than a divergence
  from the vendor — it was a violation of the RFC the twin's own OAuth flow
  implements.
- **Accepting where the vendor refuses** hides a real defect: the agent ships,
  production 400s, and the exam said green.

So the question is not "which is safer" but "which is true of this vendor",
per twin, from a measurement.

### What the disposition does NOT change

Two things, and they are what make the ruling narrow enough to take:

1. **A handler still cannot see an undeclared input.** `parse()` returns
   declared names only, in both dispositions — `readQuery` reads the declared
   names out of the search params rather than filtering what arrived, and the
   body schema is a plain `z.object` that strips. F-1179's structural
   guarantees are untouched; `ignore` decides what the CALLER is told, never
   what the handler is handed.
2. **The published artifact does not move.** `inputs` is derived from the
   declared schemas alone, so `packages/twin-*/route-inputs.json` is
   byte-identical either way (`npm run gate:route-inputs` confirmed this across
   all five twins on the change that flipped three of them). A twin whose
   declaration is short of the vendor's real surface is still exactly as
   visible to pome-cloud's declared-fidelity lane as it was. Runtime strictness
   was never how declaration completeness got enforced — that is
   `scripts/lint-route-input-declarations.mjs` plus the lane — which is why
   `ignore` costs nothing on F-1179's deliverable and had to be argued on
   fidelity alone.

## Evidence

### `twin-github` — GitHub accepts and discards

Ten surfaces, chosen to cover every shape this twin serves — root-level, user,
org, repo, repo children, wildcard path, and search. Each was called bare and
then again with `?pome_undeclared_probe=x` appended, and the two response bodies
were sha256'd rather than eyeballed:

```
SURFACE                                        BARE   PROBE  BODY
GET /rate_limit                                200    200    identical
GET /users/octocat                             200    200    identical
GET /orgs/github                               200    200    identical
GET /repos/octocat/Hello-World                 200    200    identical
GET /repos/octocat/Hello-World/issues          200    200    identical
GET /repos/octocat/Hello-World/commits         200    200    identical
GET /repos/octocat/Hello-World/branches        200    200    identical
GET /repos/octocat/Hello-World/contents/README 200    200    identical
GET /users/octocat/repos                       200    200    identical
GET /search/repositories?q=stripe              200    200    identical
GET /search/code?q=addClass                    401    401    identical
```

Not merely the same status — the same bytes, on every one. A second probe,
`?sort=not_a_real_value` — a name that IS a GitHub parameter, just not on these
routes — was also 200 everywhere, so this is not a special case for
implausible-looking names.

Body keys go the same way. `POST /markdown` is the one write GitHub serves
without a token:

```
$ curl -X POST -H 'content-type: application/json' \
    -d '{"text":"hello","pome_undeclared_probe":"x"}' https://api.github.com/markdown
<p>hello</p>
status=200
```

`GET /search/code` is in the table for completeness and proves nothing either
way: 401 bare and 401 probed is an auth gate reached before any parameter is
looked at, which is a fact about GitHub's ordering. Ten surfaces carry the
finding; that one is the control.

Recorded consequence: this twin is the one where F-1179's default was most
expensive. 66 routes refused a parameter GitHub serves.

### `twin-slack` — Slack accepts and gets on with the call

Slack authenticates before it does anything else, so `conversations.list` and
`auth.test` answer `{"ok":false,"error":"not_authed"}` to an anonymous probe
whatever it carries. `api.test` is the one Web API method that does not need a
token, and it answers the question directly:

```
$ curl 'https://slack.com/api/api.test?pome_undeclared_probe=x'
{"ok":true,"args":{"pome_undeclared_probe":"x"}}
status=200

$ curl -X POST -d 'pome_undeclared_probe=x&foo=bar' https://slack.com/api/api.test
{"ok":true,"args":{"pome_undeclared_probe":"x","foo":"bar"}}
status=200
```

`ok:true` is the ruling: an argument Slack has no use for does not stop the
call. Supporting it, Slack's own Web API page describes three ways to pass
arguments (GET query string, `application/x-www-form-urlencoded` POST, or a mix
of the two) and describes no way to have one rejected; Slack's error vocabulary
has no `unknown_argument`, and `invalid_arguments` — the code this twin refused
with — is for arguments a method HAS whose values are wrong.

Worth recording separately: every Slack error is HTTP 200 with `{ok:false}`,
which is why the twin's suite compares envelopes rather than status codes.

Recorded consequence: `token` is an ambient argument on all 62 Slack surfaces,
so a client sending one extra field alongside it met a refusal everywhere at
once.

### `twin-gmail` — Google refuses, and the probe cannot reach it

Gmail is served through Google's HTTP-to-gRPC transcoding layer, which binds
each query parameter to a field of the request proto and answers 400
`INVALID_ARGUMENT` — `Invalid JSON payload received. Unknown name "x": Cannot
bind query parameter. Field 'x' could not be found in request message.` — for
one that maps to no field. That is not a choice the Gmail team made; it is the
layer every `*.googleapis.com` method is served through, and the same error is
reported against People, Dialogflow, Natural Language and the rest.

The live probe confirms Gmail is behind that layer without reaching it. The
401 Gmail answers an anonymous caller names its backend gRPC method:

```
$ curl 'https://gmail.googleapis.com/gmail/v1/users/me/messages?pome_undeclared_probe=x'
{"error":{"code":401,"message":"Request is missing required authentication credential…",
  "status":"UNAUTHENTICATED",
  "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",
    "reason":"CREDENTIALS_MISSING","domain":"googleapis.com",
    "metadata":{"method":"caribou.api.proto.MailboxSe…"}}]}}
status=401
```

**What could not be measured, and why it is recorded rather than worked
around.** Google checks credentials before it binds parameters. The bare call
and the probed call answered the same 401, as did a call with a well-formed but
invalid API key and a call carrying a DECLARED parameter with a bad value
(`?maxResults=notanumber` → 401). The same ordering held on every other
`googleapis.com` surface reachable without credentials — Chat, People, YouTube,
Custom Search, Translate all answered 401/403 before looking at parameters, and
the two Google endpoints that DO answer anonymously (`/discovery/v1/apis`,
`gmail/$discovery/rest`) are not transcoded RPC methods and ignored the probe,
which says nothing about the layer in question. Reaching Gmail's binding layer
needs a real OAuth token for a real mailbox. It was not worth minting one to
confirm a behaviour that is uniform across Google's API frontend and that
points at the default the twin already had.

### `twin-stripe` — Stripe refuses, and says so in its own vocabulary

Stripe's published error-code reference carries:

> `parameter_unknown` — The request contains one or more unexpected parameters.
> Remove these and try again.

The twin has agreed with this since F-1179 without anyone checking: it already
renders `UndeclaredInputError` as `parameter_unknown`, which is Stripe's own
word for exactly this refusal.

**What could not be measured.** Stripe answers 401 before it validates
parameters:

```
$ curl 'https://api.stripe.com/v1/charges?pome_undeclared_probe=x'
{"error":{"message":"You did not provide an API key…","type":"invalid_request_error"}}
status=401

$ curl -u 'sk_test_bogus_key_for_probe:' 'https://api.stripe.com/v1/charges?pome_undeclared_probe=x'
{"error":{"message":"Invalid API Key provided: sk_test_***************robe",…}}
status=401
```

Reaching the validation layer needs a live secret key. Probing with the sample
publishable key Stripe puts in its own docs would have meant sending requests
against an account that is not ours, which is not a thing to do for a
confirmation of the status quo.

### `twin-linear` — the spec makes it mandatory, and Linear obeys

Four of this twin's six HTTP routes are OAuth, and there the disposition is not
the vendor's to choose. RFC 6749 says, in **§3.1** for the authorization
endpoint and again in **§3.2** for the token endpoint:

> The authorization server MUST ignore unrecognized request parameters.

`/oauth/revoke` follows the token endpoint's conventions (RFC 7009). So a twin
that 4xx'd an unknown parameter on those four was not merely diverging from
Linear, it was violating the RFC its own OAuth flow implements.

Real Linear obeys it. `GET /oauth/authorize` renders its consent page for a
bogus client, so it is reachable without credentials, and it is unmoved:

```
GET /oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=read
  bare    → 200, 24446 bytes
  +probe  → 200, 24446 bytes      (differing only in a per-request CSP nonce)
```

`POST /oauth/token` answered the same thing both ways — the unknown parameter
changed nothing about how it failed:

```
$ curl -X POST -d 'grant_type=authorization_code&code=probe&client_id=probe&…' \
    https://api.linear.app/oauth/token
{"error":"invalid_client","error_description":"Invalid client: client is invalid"}
status=400                                    # identical with &pome_undeclared_probe=x
```

The remaining two routes are `/graphql`, where the envelope (`query` /
`variables` / `operationName`) is the declared input. An unknown top-level key
in the JSON body, and an unknown key in the query string, each left Linear's
answer byte for byte where it was — it went on to fail on authentication, which
is what it does for the bare request too.

**One thing this does not settle.** GraphQL-over-HTTP has a fourth envelope
member, `extensions`, which Apollo clients send for persisted queries. This
twin declares it nowhere, and real Linear does not ignore it — it answers 400
`INTERNAL_SERVER_ERROR`, before authentication, apparently because persisted
queries are not enabled:

```
$ curl -X POST -H 'content-type: application/json' \
    -d '{"query":"{__typename}","extensions":{"persistedQuery":{"version":1,"sha256Hash":"abc"}}}' \
    https://api.linear.app/graphql
{"errors":[{"message":"Internal server error","extensions":{"http":{"status":400,…}}}]}
```

That is a DECLARATION gap, not a disposition question — the twin does not model
`extensions` at all — and under `ignore` the twin now serves such a request
where Linear rejects it. It is the declared-fidelity lane's finding to report,
and worth a ticket of its own.

## How a disposition is changed

The failure mode this ticket was created by: the first attempt at `ignore`
edited the source and not the tests, which reddened roughly 200 route
assertions across four suites and got reverted rather than reconciled. Two
things now make that reconciliation compulsory rather than remembered.

1. Each twin's `test/route-input-declarations.test.ts` pins its ruling as a
   literal (`const RULED: UndeclaredDisposition = …`) and asserts every one of
   that twin's declarations carries it. Flipping the source alone fails that
   assertion, by name, on the first route.
2. The same suite drives the behaviour the ruling implies over real HTTP. For
   an `ignore` twin that means two apps taken through the identical sequence of
   requests, one of them with the probe appended to every call, asserting the
   two agree answer for answer — a discarded input cannot change a reply, so
   parity on the 404s and 422s is as much of the claim as parity on the 200s.

So a flip is: measure the vendor, add the transcript here, change the one
`routeInputDeclarer()` line, change the one `RULED` line. Anything less is red.
