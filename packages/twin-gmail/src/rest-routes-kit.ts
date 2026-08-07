// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import {
  MalformedBodyError,
  UndeclaredInputError,
  mountDeclaredRoute,
  type DeclarableRouter,
  type DeclaredRouteInputs,
  type RouteInputDeclaration,
  type RouteInputSpec,
  type RouteRequestSource,
} from "@pome-sh/sdk/route-inputs";
import type { GmailDomain } from "./domain/index.js";
import { invalidArgument } from "./errors.js";
import { gmailStateDelta } from "./state.js";
import { GmailRestSerializers } from "./rest-serializers.js";

export type RouteResult = { status?: number; body: unknown; mutation?: boolean };

/** A handler's only view of the request is its declaration's output. */
export type DeclaredHandler<S extends RouteInputSpec> = (
  input: DeclaredRouteInputs<S>,
  c: Context
) => RouteResult | Promise<RouteResult>;

/**
 * The handler a named declaration expects, read off that declaration's own
 * `parse`. Used where one handler is mounted at two paths (Gmail's
 * `/gmail/...` and `/upload/gmail/...` pairs) and so needs a name.
 */
export type DeclaredHandlerFor<D extends { parse: (request: never) => Promise<unknown> }> = (
  input: Awaited<ReturnType<D["parse"]>>,
  c: Context
) => RouteResult | Promise<RouteResult>;

export class GmailRouteKit {
  readonly serializers: GmailRestSerializers;

  constructor(readonly context: RouteContext<GmailDomain>) {
    this.serializers = new GmailRestSerializers(context.domain);
  }

  get domain(): GmailDomain {
    return this.context.domain;
  }

  read<S extends RouteInputSpec>(
    app: DeclarableRouter,
    declaration: RouteInputDeclaration<S>,
    fn: DeclaredHandler<S>
  ): void {
    mountDeclaredRoute(
      app,
      declaration,
      this.context.recorder.handle({ mutation: false }, async (c) => {
        const result = await fn(await parseDeclared(declaration, c), c);
        return { status: result.status ?? 200, body: result.body, mutation: false };
      })
    );
  }

  write<S extends RouteInputSpec>(
    app: DeclarableRouter,
    declaration: RouteInputDeclaration<S>,
    fn: DeclaredHandler<S>
  ): void {
    mountDeclaredRoute(
      app,
      declaration,
      this.context.recorder.handle({ mutation: true }, async (c) => {
        const input = await parseDeclared(declaration, c);
        const before = this.context.domain.exportState();
        const result = await fn(input, c);
        const wantsMutation = result.mutation ?? true;
        const delta = wantsMutation
          ? gmailStateDelta(before, this.context.domain.exportState())
          : null;
        // Accurate state_mutation: no-op writes (empty delta) did not mutate state.
        const mutation = wantsMutation && delta !== null;
        return {
          status: result.status ?? 200,
          body: result.body,
          mutation,
          delta,
        };
      })
    );
  }

  /**
   * A route the twin serves only to answer 501.
   *
   * It does NOT parse its declaration: "this operation is not implemented" is
   * the honest answer to a well-formed resumable-upload or Pub/Sub request, and
   * parsing first would turn a real `users.watch` body into a 400 about an
   * undeclared parameter. The declarations exist so the surface is published
   * and so the mount point still has exactly one home.
   */
  unsupported(
    app: DeclarableRouter,
    declaration: Pick<RouteInputDeclaration, "method" | "path">,
    message: string
  ): void {
    mountDeclaredRoute(
      app,
      declaration,
      this.context.recorder.handle({ mutation: false, fidelity: "unsupported" }, () => ({
        status: 501,
        body: {
          error: {
            code: 501,
            message,
            errors: [{ message, domain: "global", reason: "notImplemented" }],
            status: "UNIMPLEMENTED",
          },
        },
        mutation: false,
      }))
    );
  }
}

/** Project the declaration's refusals into Gmail's own error envelope. */
async function parseDeclared<S extends RouteInputSpec>(
  declaration: RouteInputDeclaration<S>,
  c: Context
): Promise<DeclaredRouteInputs<S>> {
  try {
    return await declaration.parse(c.req as unknown as RouteRequestSource);
  } catch (error) {
    if (error instanceof UndeclaredInputError) {
      // Google answers an unrecognised parameter with 400 INVALID_ARGUMENT.
      invalidArgument(`Invalid ${error.location} parameter: ${error.first}`);
    }
    if (error instanceof MalformedBodyError) invalidArgument("Invalid JSON payload received.");
    throw error;
  }
}
