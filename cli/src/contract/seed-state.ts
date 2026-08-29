// SPDX-License-Identifier: Apache-2.0
//
// contract — provider seed-state schemas (part of §3 TASKS). The
// per-provider seed worlds (GitHub / Stripe / Slack), the provider-scoped
// wrapper, and the legacy-or-scoped `seedStateSchema` union consumed by
// `taskSchema`. Re-exported through the `cli/src/contract` barrel.

import { z } from "zod";
// The github seed shape is the TWIN's — see the block below. Imported as well
// as re-exported because `providerScopedSeedStateSchema` needs the value.
import { seedSchema as githubSeedSchema } from "@pome-sh/twin-github/seed";

// ── GITHUB: THE TWIN'S OWN SCHEMA, NOT A DECLARATION OF IT ─────────────────
//
// This arm was hand-written, and nothing compared it to
// `packages/twin-github/src/seed.ts`. Measured 2026-08-29 against a maximal
// github seed, the copy silently dropped EIGHT fields the twin models:
//
//     repositories[].private, .milestones, .tags, .releases
//     issues[].assignees        (replaced by a fabricated `assignee: null`)
//     issues[].comments
//     pull_requests[].comments, .review_comments
//
// The visible cost is not a type error. `GithubSeedState` is `z.infer` of this
// schema, so the TYPE said a seeded milestone did not exist — and its own header
// claimed to be "matching the canonical twin-github seed shape" while four of
// those five entities had landed in the twin since it was written. Nothing in
// this repo `.parse()`s it (the create-session boundary is a permissive
// `z.record` on purpose, F-580), which is why the drift was invisible: a
// declaration no test runs is a claim nothing checks.
//
// So it is the twin's object, re-exported under this module's name —
// `cli/src/task/taskSchema.ts` has done exactly this since it was written, and
// two schemas that are the SAME schema cannot drift. The seed shape is the
// twin's to own (ADR-015): this file declares the /v1 surface, and for a seed
// the /v1 surface IS whatever the twin boots.
//
// `@pome-sh/twin-github/seed` is a zod-only leaf — it imports nothing but `zod`
// and its own types — so naming it here costs the CLI startup graph nothing.
// `taskSchema.ts` and `parseTask.ts` already reach it the same way.
export { seedSchema as githubSeedStateSchema } from "@pome-sh/twin-github/seed";
export type { ParsedGitHubStateSeed as GithubSeedState } from "@pome-sh/twin-github/seed";

export const stripeSeedStateSchema = z.object({
  api_keys: z
    .array(
      z.object({
        key: z.string().min(1).default("sk_test_pome_default"),
        sid: z.string().min(1).default("default"),
        account_id: z.string().min(1).optional(),
      })
    )
    .default([]),
  customers: z.array(z.record(z.string(), z.unknown())).default([]),
  products: z.array(z.record(z.string(), z.unknown())).default([]),
  prices: z.array(z.record(z.string(), z.unknown())).default([]),
  payment_intents: z.array(z.record(z.string(), z.unknown())).default([]),
  charges: z.array(z.record(z.string(), z.unknown())).default([]),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  balances: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type StripeSeedState = z.infer<typeof stripeSeedStateSchema>;

export const slackSeedStateSchema = z.object({
  team: z
    .object({
      id: z.string().regex(/^T[A-Z0-9_]+$/).optional(),
      name: z.string().default("Pome Twin Workspace"),
      domain: z.string().default("pome-twin"),
    })
    .prefault({}),
  users: z
    .array(
      z.object({
        id: z.string().regex(/^[UB][A-Z0-9_]+$/).optional(),
        name: z.string().min(1),
        real_name: z.string().default(""),
        email: z.string().email().optional(),
        is_bot: z.boolean().default(false),
        is_admin: z.boolean().default(false),
        tz: z.string().default("America/Los_Angeles"),
        profile: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .default([]),
  channels: z
    .array(
      z.object({
        id: z.string().regex(/^[CGDM][A-Z0-9_]+$/).optional(),
        name: z.string().regex(/^[a-z0-9_-]{1,80}$/),
        is_private: z.boolean().default(false),
        topic: z.string().default(""),
        purpose: z.string().default(""),
        creator: z.string().optional(),
        members: z.array(z.string()).default([]),
        messages: z
          .array(
            z.object({
              ts: z.string().optional(),
              user: z.string(),
              text: z.string(),
              thread_ts: z.string().optional(),
              reactions: z
                .array(z.object({ name: z.string(), user: z.string() }))
                .default([]),
            })
          )
          .default([]),
      })
    )
    .default([]),
  // Same shape as `seedSchema.files` in `@pome-sh/twin-slack`. `user` and
  // `channels` are seed HANDLES (a user/channel `name`) or ids.
  files: z
    .array(
      z.object({
        id: z.string().regex(/^F[A-Z0-9_]+$/).optional(),
        name: z.string().min(1),
        title: z.string().optional(),
        filetype: z.string().min(1).default("text"),
        user: z.string().optional(),
        channels: z.array(z.string()).default([]),
        content: z.string().optional(),
      })
    )
    .default([]),
  emoji: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_+-]{1,100}$/),
        url: z.string().url().optional(),
        alias: z.string().regex(/^[a-z0-9_+-]{1,100}$/).optional(),
      })
    )
    .default([]),
});
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;

const gmailEmailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const gmailIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const gmailAttachmentSeedSchema = z.object({
  filename: z.string().max(512),
  mimeType: z.string().min(1).max(255).default("application/octet-stream"),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
  contentId: z.string().max(998).optional(),
  data: z.string().max(50_000_000),
});

const gmailMessageSeedFields = {
  id: gmailIdSchema.optional(),
  threadId: gmailIdSchema.optional(),
  raw: z.string().max(50_000_000).optional(),
  from: gmailEmailSchema.optional(),
  to: z.array(gmailEmailSchema).max(500).default([]),
  cc: z.array(gmailEmailSchema).max(500).default([]),
  bcc: z.array(gmailEmailSchema).max(500).default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(25_000_000).default(""),
  html: z.string().max(25_000_000).default(""),
  date: z.string().datetime({ offset: true }).optional(),
  messageId: z.string().min(3).max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).default([]),
  attachments: z.array(gmailAttachmentSeedSchema).max(100).default([]),
};

/** Aligns with twin-gmail `seed.ts` filter shape; query AST is validated at twin parse time. */
const gmailFilterSeedSchema = z
  .object({
    id: gmailIdSchema.optional(),
    criteria: z
      .object({
        from: z.string().max(998).optional(),
        to: z.string().max(998).optional(),
        subject: z.string().max(998).optional(),
        query: z.string().max(4096).optional(),
        negatedQuery: z.string().max(4096).optional(),
        hasAttachment: z.boolean().optional(),
        excludeChats: z.boolean().optional(),
        size: z.number().int().nonnegative().optional(),
        sizeComparison: z.enum(["larger", "smaller"]).optional(),
      })
      .default({}),
    action: z
      .object({
        addLabelIds: z.array(z.string().min(1)).max(100).default([]),
        removeLabelIds: z.array(z.string().min(1)).max(100).default([]),
        /** Twin rejects filter forwarding (no delivery); keep field for drift detection. */
        forward: gmailEmailSchema.optional(),
      })
      .default({ addLabelIds: [], removeLabelIds: [] }),
  })
  .superRefine((filter, ctx) => {
    if (filter.action.forward) {
      ctx.addIssue({
        code: "custom",
        message: "Filter forwarding is unsupported",
        path: ["action", "forward"],
      });
    }
  });

const gmailMailboxSeedSchema = z.object({
  email: gmailEmailSchema,
  displayName: z.string().max(256).default(""),
  labels: z
    .array(
      z.object({
        id: gmailIdSchema.optional(),
        name: z.string().trim().min(1).max(225),
        color: z
          .object({
            textColor: z.string().max(32).optional(),
            backgroundColor: z.string().max(32).optional(),
          })
          .optional(),
      }),
    )
    .max(5000)
    .default([]),
  messages: z
    .array(
      z.object({
        ...gmailMessageSeedFields,
        labels: z.array(z.string().min(1).max(255)).max(100).default([]),
      }),
    )
    .max(10_000)
    .default([]),
  drafts: z.array(z.object(gmailMessageSeedFields)).max(5000).default([]),
  filters: z.array(gmailFilterSeedSchema).max(1000).default([]),
  forwardingAddresses: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
  sendAs: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
});

// Named fault-injection primitives (mirror of twin-gmail `faults.ts`). Opt-in;
// default seeds carry none. See CONTRACT.md (Gmail pins).
const gmailFaultSchema = z
  .object({
    name: z.enum(["rate-limited"]),
    target: z.string().min(1).max(128).default("messages.send"),
    succeedFirst: z.number().int().nonnegative().max(1000).default(2),
    throttleFor: z.number().int().positive().max(1000).default(3),
    retryAfterSeconds: z.number().int().positive().max(3600).default(1),
  })
  .strict();

export const gmailSeedStateSchema = z.object({
  primaryMailbox: gmailMailboxSeedSchema,
  mailboxes: z.array(gmailMailboxSeedSchema).max(100).default([]),
  deliveryMode: z.enum(["sender-only", "seeded-mailboxes"]).default("sender-only"),
  clock: z.string().datetime({ offset: true }).default("2025-01-01T00:00:00.000Z"),
  faults: z.array(gmailFaultSchema).max(50).default([]),
});
export type GmailSeedState = z.infer<typeof gmailSeedStateSchema>;

/** Aligns with twin-linear `seed.ts` shape; twin parseSeed applies strict cross-refs. */
const linearEmailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const linearIdSchema = z.string().min(1).max(128);
const linearDatetimeSchema = z.string().datetime({ offset: true });
const linearScopesSchema = z
  .union([z.array(z.string().min(1).max(64)).max(50), z.string().max(500)])
  .optional();
const linearStateTypeSchema = z.enum(["backlog", "unstarted", "started", "completed", "canceled"]);

export const linearSeedStateSchema = z.object({
  clock: linearDatetimeSchema.default("2026-07-21T00:00:00.000Z"),
  defaultSid: z.string().min(1).max(128).default("standalone"),
  baseUrl: z.string().url().default("http://127.0.0.1:3337"),
  strictScopes: z.boolean().default(false),
  organization: z
    .object({
      id: linearIdSchema.optional(),
      name: z.string().min(1).max(200).optional(),
      urlKey: z.string().min(1).max(100).optional(),
    })
    .optional(),
  users: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        email: linearEmailSchema,
        name: z.string().min(1).max(200).optional(),
        displayName: z.string().min(1).max(200).optional(),
        avatarUrl: z.string().url().nullable().optional(),
        active: z.boolean().default(true),
        admin: z.boolean().default(false),
        app: z.boolean().default(false),
      }),
    )
    .max(500)
    .default([]),
  teams: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        key: z.string().min(1).max(20),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        private: z.boolean().default(false),
        states: z
          .array(
            z.object({
              id: linearIdSchema.optional(),
              name: z.string().min(1).max(100),
              type: linearStateTypeSchema.optional(),
              position: z.number().int().nonnegative().optional(),
            }),
          )
          .max(50)
          .optional(),
      }),
    )
    .max(50)
    .default([]),
  labels: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        name: z.string().min(1).max(100),
        color: z.string().max(32).optional(),
        description: z.string().max(2000).nullable().optional(),
        team: z.string().min(1).max(128).optional(),
      }),
    )
    .max(500)
    .default([]),
  projects: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        name: z.string().min(1).max(200),
        description: z.string().max(10_000).nullable().optional(),
        state: z.enum(["planned", "started", "completed", "canceled"]).default("planned"),
        team: z.string().min(1).max(128).optional(),
      }),
    )
    .max(200)
    .default([]),
  cycles: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        team: z.string().min(1).max(128),
        name: z.string().min(1).max(200),
        number: z.number().int().positive().optional(),
        startsAt: linearDatetimeSchema.nullable().optional(),
        endsAt: linearDatetimeSchema.nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
  issues: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        team: z.string().min(1).max(128),
        title: z.string().min(1).max(512),
        description: z.string().max(65_536).nullable().optional(),
        priority: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .default(0),
        state: z.string().min(1).max(128).optional(),
        assignee: z.string().min(1).max(200).optional(),
        creator: z.string().min(1).max(200).optional(),
        delegate: z.string().min(1).max(200).optional(),
        project: z.string().min(1).max(200).optional(),
        cycle: z.string().min(1).max(200).optional(),
        parent: z.string().min(1).max(200).optional(),
        estimate: z.number().int().nonnegative().nullable().optional(),
        labels: z.array(z.string().min(1).max(100)).max(50).default([]),
        dueDate: z.string().max(32).nullable().optional(),
        createdAt: linearDatetimeSchema.optional(),
        updatedAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(5000)
    .default([]),
  comments: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        issue: z.string().min(1).max(128),
        body: z.string().min(1).max(65_536),
        parent: z.string().min(1).max(128).optional(),
        user: z.string().min(1).max(200).optional(),
        createdAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(20_000)
    .default([]),
  documents: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        title: z.string().min(1).max(512),
        content: z.string().max(65_536).nullable().optional(),
        slug: z.string().min(1).max(200).optional(),
        project: z.string().min(1).max(200).optional(),
        team: z.string().min(1).max(128).optional(),
        issue: z.string().min(1).max(200).optional(),
        cycle: z.string().min(1).max(200).optional(),
        icon: z.string().max(64).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
        creator: z.string().min(1).max(200).optional(),
        createdAt: linearDatetimeSchema.optional(),
        updatedAt: linearDatetimeSchema.optional(),
      }),
    )
    .max(500)
    .default([]),
  oauthApps: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        clientId: z.string().min(1).max(200),
        clientSecret: z.string().min(1).max(500),
        name: z.string().min(1).max(200),
        redirectUris: z.array(z.string().url()).min(1).max(20),
        scopes: linearScopesSchema,
        actor: z.enum(["user", "app"]).default("user"),
        assignable: z.boolean().default(false),
        mentionable: z.boolean().default(false),
        appUserId: z.string().min(1).max(128).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  tokens: z
    .array(
      z.object({
        token: z.string().min(1).max(500),
        type: z.enum(["personal", "oauth_access", "client_credentials"]).default("personal"),
        user: z.string().min(1).max(200).optional(),
        app: z.string().min(1).max(200).optional(),
        scopes: linearScopesSchema,
        actor: z.enum(["user", "app"]).optional(),
        sid: z.string().min(1).max(128).optional(),
        expiresAt: linearDatetimeSchema.nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  webhooks: z
    .array(
      z.object({
        id: linearIdSchema.optional(),
        label: z.string().min(1).max(200).optional(),
        url: z.string().url(),
        resourceTypes: linearScopesSchema,
        team: z.string().min(1).max(128).optional(),
        allPublicTeams: z.boolean().optional(),
        secret: z.string().max(500).nullable().optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .max(50)
    .default([]),
});
export type LinearSeedState = z.infer<typeof linearSeedStateSchema>;

export const providerScopedSeedStateSchema = z
  .object({
    github: z.object({ seed: githubSeedSchema }).optional(),
    stripe: z.object({ seed: stripeSeedStateSchema }).optional(),
    slack: z.object({ seed: slackSeedStateSchema }).optional(),
    gmail: z.object({ seed: gmailSeedStateSchema }).optional(),
    linear: z.object({ seed: linearSeedStateSchema }).optional(),
  })
  .refine(
    (value) => Boolean(value.github || value.stripe || value.slack || value.gmail || value.linear),
    {
      message:
        "seedState must include github.seed, stripe.seed, slack.seed, gmail.seed, linear.seed, or the legacy GitHub seed shape",
    },
  );

// SeedState accepts the legacy GitHub shape and the provider-scoped shape
// used by GitHub + Stripe scenario templates.
export const seedStateSchema = z.union([githubSeedSchema, providerScopedSeedStateSchema]);
export type SeedState = z.infer<typeof seedStateSchema>;
