// file-size: one declaration mechanism, one parser, one derivation — splitting the three would let the derived declaration and the parser that enforces it live in separate files, which is the drift this module exists to make impossible.
// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — the route INPUT declaration, and the parser that is the same object.
//
// # Why this exists
//
// pome-cloud's declared-fidelity lane compares what a vendor declares it
// accepts against what our twin accepts. Before this module the twin side was
// unreadable for the four HTTP twins: request BODIES had zod schemas held in
// module-private consts, query and path params were read imperatively
// (`c.req.query("state")`), and nothing named them anywhere a second process
// could see. 1,130 vendor-declared inputs on matched surfaces reported
// `not-compared`.
//
// The obvious fix — write the input list down somewhere — is the one that must
// not be taken. A hand-written list of what a handler accepts is a second
// source of truth, and it drifts from the handler silently. A lane reporting
// divergence that is not real is worse than one honestly reporting
// `not-compared`, because it teaches people to ignore it.
//
// So the declaration here is not a description of the parse. It IS the parse:
//
//   * `declareRouteInputs()` takes zod schemas per input LOCATION and returns a
//     `RouteInputDeclaration` carrying both `inputs` (the machine-readable
//     surface, derived from those schemas) and `parse()` (the only way a
//     handler ever sees a request value).
//   * A handler receives `parse()`'s output and nothing else. It is handed no
//     request object to read around the declaration with.
//   * `parse()` REFUSES a query key or a top-level body key the declaration
//     does not name. Undeclared input is not ignored, it is an error.
//
// Those three together make the two failure modes the ticket names structurally
// impossible rather than merely absent today: a handler cannot accept a
// parameter absent from the declaration (it never receives one), and it cannot
// reject one present in it (the declaration is what validates).
//
// The remaining hole an in-process mechanism cannot close by itself is a
// handler that ignores its parsed input and reaches for the raw request
// anyway. That is a repo-level gate, not a type: `scripts/lint-route-input-
// declarations.mjs` walks every route-registering module in every twin and
// every in-twin module it reaches, and fails on `c.req.query(`, `c.req.param(`,
// `c.req.json(`, `c.req.parseBody(`, `c.req.header(` and the rest of the
// imperative reads. This module and that gate are two halves of one
// invariant; neither is sufficient alone.
//
// # Deliberately NOT strict about headers
//
// Query and body keys are refused when undeclared. Headers are not: every HTTP
// client on earth sends a dozen headers no API declares, and rejecting them
// would make the twins unreachable. The declaration still governs which
// headers a handler can SEE — `parse()` returns only declared ones — so a
// header the twin actually reads is always named. Unnamed headers are ignored,
// which is what every vendor does with them.
//
// # Portability
//
// zod is this module's only import, and the request material it needs is
// described by the `RouteRequestSource` interface rather than by hono's
// `Context`. That keeps it loadable in bun (pome-cloud's `tools/fidelity-watch`
// runs there) and importable by the artifact emitter with no engine behind it.
// See `scripts/check-twin-leaf-portability.mjs`.

import { z } from "zod";

/**
 * Where an input arrives, spelled the way pome-cloud's `UpstreamInput` spells
 * it so the two sides of the comparison speak one vocabulary. `cookie` is
 * absent because no twin reads one.
 *
 * `declareRouteInputs` only ever produces the four HTTP locations. `argument`
 * exists for twin-linear, whose non-MCP API layer is GraphQL: its input surface
 * is root-field ARGUMENTS, projected from the executable schema it already
 * serves every request against rather than declared a second time.
 */
export type InputLocation = "path" | "query" | "header" | "body" | "argument";

export const INPUT_LOCATIONS: readonly InputLocation[] = [
  "path",
  "query",
  "header",
  "body",
  "argument",
];

/** One input a route accepts, as the route's own schemas define it. */
export interface DeclaredInput {
  readonly name: string;
  readonly location: InputLocation;
  /** True when `parse()` rejects the request with this input absent. */
  readonly required: boolean;
  /**
   * Best-effort JSON-Schema type name derived from the zod schema
   * (`string`, `integer`, `array`, `object`, …), `null` when the schema has no
   * single representable type. Never hand-written: a typed field nobody can
   * derive is a field that can lie.
   */
  readonly type: string | null;
}

/**
 * How the request body reaches a plain object the declared shape can validate.
 * Transport, not naming — whichever encoding is used, the NAMES still come
 * from the declaration and an undeclared one is still refused.
 */
export type BodyEncoding =
  /** No body is read. The declaration must name no body inputs. */
  | "none"
  /** `application/json`; unparseable is an error the caller must see. */
  | "json"
  /** `application/json`; unparseable or empty decodes to `{}`. */
  | "json-optional"
  /**
   * JSON, `application/x-www-form-urlencoded` or `multipart/form-data`, with
   * Stripe's bracket encoding (`items[0][price]=x`) expanded to nested
   * objects. Unparseable decodes to `{}`.
   */
  | "form"
  /**
   * Gmail's upload shapes: a JSON resource, a `multipart/related` metadata +
   * media pair, or a bare MIME body. The media bytes land on the declared
   * input named by `mediaField`.
   */
  | "media";

/** HTTP methods a declaration can be registered on. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";

const ROUTE_METHODS: readonly RouteMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"];

type Shape = Record<string, z.ZodType>;

/** Marks a query input whose `name[sub]` sub-keys are also accepted (Stripe's
 *  deepObject style: `created[gte]=1`). The parsed value is the nested object
 *  when sub-keys are present, the flat value otherwise. */
const BRACKETED = Symbol.for("pome.routeInputs.bracketed");

interface Bracketed<T extends z.ZodType> {
  readonly [BRACKETED]: true;
  readonly schema: T;
}

/**
 * Declare a query input that also accepts `name[sub]` sub-keys, Stripe's
 * `created[gte]=…` shape. One declared name covers the family: the vendor
 * declares one parameter too, so declaring five would report drift that is not
 * real.
 */
export function bracketedQuery<T extends z.ZodType>(schema: T): T {
  const wrapper: Bracketed<T> = { [BRACKETED]: true, schema };
  // Returned as `T` so the spec stays a plain shape of zod types to its
  // reader; `isBracketed` is the only thing that looks past the cast.
  return wrapper as unknown as T;
}

function isBracketed(value: unknown): value is Bracketed<z.ZodType> {
  return typeof value === "object" && value !== null && BRACKETED in value;
}

function unwrapBracketed(value: z.ZodType): z.ZodType {
  return isBracketed(value) ? value.schema : value;
}

/** The request material a declaration needs. `hono`'s `c.req` satisfies it. */
export interface RouteRequestSource {
  /** Named path parameter, as the router captured it. */
  param(name: string): string | undefined;
  /** Full request URL — read for its query string, and for a wildcard segment. */
  readonly url: string;
  header(name: string): string | undefined;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  parseBody(options?: { all?: boolean }): Promise<Record<string, unknown>>;
}

/** What a handler receives. The only route input surface it has. */
export interface ParsedRouteInputs<P, Q, H, B> {
  readonly path: P;
  readonly query: Q;
  readonly header: H;
  readonly body: B;
}

type Infer<S extends Shape | undefined> = S extends Shape
  ? { [K in keyof S]: z.infer<S[K]> }
  : Record<string, never>;

export interface RouteInputSpec {
  method: RouteMethod;
  /** The router pattern this declaration is registered on, verbatim. */
  path: string;
  /** Named path params and, when `path` contains `*`, the wildcard's name. */
  pathParams?: Shape;
  query?: Shape;
  /** Headers the handler reads. Undeclared headers are ignored, not refused. */
  headers?: Shape;
  /** Top-level body input names. Nested shape is the schemas' business. */
  body?: Shape;
  bodyEncoding?: BodyEncoding;
  /** For `bodyEncoding: "media"`, the (optionally dotted) body path the media
   *  bytes land on, e.g. `"raw"` or `"message.raw"`. */
  mediaField?: string;
}

export interface RouteInputDeclaration<S extends RouteInputSpec = RouteInputSpec> {
  readonly method: RouteMethod;
  readonly path: string;
  /** `"<METHOD> <path>"` — the identity this surface publishes under. */
  readonly surface: string;
  readonly bodyEncoding: BodyEncoding;
  /** Every input, sorted by location then name. Derived, never written. */
  readonly inputs: readonly DeclaredInput[];
  /** Just the names, deduplicated — the shape pome-cloud's comparator diffs. */
  readonly names: readonly string[];
  /**
   * Validate a request against this declaration and return the ONLY view of it
   * a handler gets.
   *
   * Throws `UndeclaredInputError` for a query or top-level body key this
   * declaration does not name, `z.ZodError` when a declared input fails its own
   * schema, and `MalformedBodyError` when `bodyEncoding: "json"` cannot decode.
   */
  parse(
    request: RouteRequestSource
  ): Promise<
    ParsedRouteInputs<
      Infer<S["pathParams"]>,
      Infer<S["query"]>,
      Infer<S["headers"]>,
      Infer<S["body"]>
    >
  >;
}

/** What a handler wrapped around declaration `S` receives. */
export type DeclaredRouteInputs<S extends RouteInputSpec> = Awaited<
  ReturnType<RouteInputDeclaration<S>["parse"]>
>;

/**
 * The router surface a declaration is mounted on. hono's `Hono` satisfies it
 * structurally; typed here so this module needs no hono import and stays
 * loadable wherever the artifact emitter and pome-cloud read it.
 */
export interface DeclarableRouter {
  get(path: string, handler: never): unknown;
  post(path: string, handler: never): unknown;
  put(path: string, handler: never): unknown;
  patch(path: string, handler: never): unknown;
  delete(path: string, handler: never): unknown;
  all(path: string, handler: never): unknown;
}

/**
 * Mount a handler at the method and path its own declaration carries.
 *
 * This is why the declaration cannot describe a route it is not: there is no
 * second place where the method and path are written down.
 */
export function mountDeclaredRoute(
  router: DeclarableRouter,
  declaration: Pick<RouteInputDeclaration, "method" | "path">,
  handler: unknown
): void {
  const verb = declaration.method.toLowerCase() as keyof DeclarableRouter;
  router[verb](declaration.path, handler as never);
}

/** A query or body key the route's declaration does not name. */
export class UndeclaredInputError extends Error {
  constructor(
    readonly location: Extract<InputLocation, "query" | "body">,
    readonly names: readonly string[],
    readonly surface: string
  ) {
    super(
      `${surface} does not declare ${location} parameter${names.length > 1 ? "s" : ""}: ` +
        names.map((name) => `\`${name}\``).join(", ")
    );
    this.name = "UndeclaredInputError";
  }

  /** The first offending name — what a vendor envelope usually reports. */
  get first(): string {
    return this.names[0] ?? "";
  }
}

/** A `bodyEncoding: "json"` body that did not decode. */
export class MalformedBodyError extends Error {
  constructor(readonly surface: string) {
    super(`${surface} could not parse the request body as JSON`);
    this.name = "MalformedBodyError";
  }
}

// ─── Declaration ─────────────────────────────────────────────────────────────

/**
 * Build a route's input declaration from the zod schemas that validate it.
 *
 * The returned object is registered ON the router (its `method` and `path` are
 * the ones the route is mounted at, so those cannot drift either) and its
 * `parse()` is the handler's only source of request values.
 */
export function declareRouteInputs<const S extends RouteInputSpec>(
  spec: S
): RouteInputDeclaration<S> {
  if (!ROUTE_METHODS.includes(spec.method)) {
    throw new Error(`route-inputs: unknown method '${spec.method}' for ${spec.path}`);
  }
  if (!spec.path.startsWith("/")) {
    throw new Error(`route-inputs: path must start with '/' (got '${spec.path}')`);
  }
  const surface = `${spec.method} ${spec.path}`;
  const pathShape = spec.pathParams ?? {};
  const queryShape = spec.query ?? {};
  const headerShape = spec.headers ?? {};
  const bodyShape = spec.body ?? {};
  const bodyEncoding: BodyEncoding =
    spec.bodyEncoding ?? (Object.keys(bodyShape).length > 0 ? "json" : "none");

  if (bodyEncoding === "none" && Object.keys(bodyShape).length > 0) {
    throw new Error(`route-inputs: ${surface} declares body inputs with bodyEncoding 'none'`);
  }
  if (bodyEncoding === "media" && !spec.mediaField) {
    throw new Error(`route-inputs: ${surface} uses bodyEncoding 'media' without mediaField`);
  }

  const { named, wildcard } = splitPathParams(surface, spec.path, Object.keys(pathShape));

  // One name MAY appear in two locations, and has to be allowed to.
  //
  // The vendors do it constantly: Gmail's `drafts.update` takes the draft id in
  // the path AND a Draft resource body that carries `id`; GitHub echoes a path
  // id in PATCH bodies the same way. Both accept the echo. An earlier draft of
  // this module threw on the collision, which turned accept-and-discard into a
  // 400 — a divergence manufactured by our own type rule, in the worst
  // direction: an agent written against the real vendor sends the echo, the twin
  // rejects it, and the exam records a failure the agent did not commit. This
  // ticket declares what the twin accepts; it does not invent refusals.
  //
  // Nothing downstream is ambiguous: `parse()` returns the four locations
  // separately, and the artifact carries `location` per input, so a name in two
  // places publishes as two inputs — which is what it is.
  const inputs: DeclaredInput[] = [];
  for (const [location, shape] of [
    ["path", pathShape],
    ["query", queryShape],
    ["header", headerShape],
    ["body", bodyShape],
  ] as const) {
    for (const [name, rawSchema] of Object.entries(shape)) {
      const schema = unwrapBracketed(rawSchema);
      inputs.push({
        name,
        location,
        // Requiredness is asked of the validator rather than read off the
        // schema's internals: "would this parse with the input absent" is the
        // question the declaration answers, so the answer comes from the same
        // code path that answers it at request time.
        required: !schema.safeParse(undefined).success,
        type: jsonSchemaTypeOf(schema),
      });
      if (isBracketed(rawSchema) && location !== "query") {
        throw new Error(`route-inputs: bracketedQuery() is only valid for query inputs (${surface} '${name}')`);
      }
    }
  }
  inputs.sort(
    (a, b) =>
      INPUT_LOCATIONS.indexOf(a.location) - INPUT_LOCATIONS.indexOf(b.location) ||
      a.name.localeCompare(b.name)
  );

  const declaredQuery = new Set(Object.keys(queryShape));
  const bracketedQueryNames = new Set(
    Object.entries(queryShape)
      .filter(([, schema]) => isBracketed(schema))
      .map(([name]) => name)
  );
  const declaredBody = new Set(Object.keys(bodyShape));
  const arrayQuery = new Set(
    Object.entries(queryShape)
      .filter(([, schema]) => jsonSchemaTypeOf(unwrapBracketed(schema)) === "array")
      .map(([name]) => name)
  );

  const pathSchema = z.object(mapShape(pathShape));
  const querySchema = z.object(mapShape(queryShape));
  const headerSchema = z.object(mapShape(headerShape));
  const bodySchema = z.object(mapShape(bodyShape));

  return {
    method: spec.method,
    path: spec.path,
    surface,
    bodyEncoding,
    inputs,
    // Deduplicated: pome-cloud's comparator diffs NAME sets, and a name that
    // arrives in two locations is still one name to it.
    names: [...new Set(inputs.map((input) => input.name))],
    async parse(request) {
      const path = pathSchema.parse(
        readPathParams(request, named, wildcard, spec.path)
      ) as Infer<S["pathParams"]>;

      const searchParams = new URL(request.url, "http://twin.invalid").searchParams;
      refuseUndeclared("query", surface, [...searchParams.keys()], declaredQuery, bracketedQueryNames);
      const query = querySchema.parse(
        readQuery(searchParams, declaredQuery, bracketedQueryNames, arrayQuery)
      ) as Infer<S["query"]>;

      const header = headerSchema.parse(
        Object.fromEntries(
          Object.keys(headerShape).map((name) => [name, request.header(name)])
        )
      ) as Infer<S["headers"]>;

      const raw = await decodeBody(request, bodyEncoding, surface, spec.mediaField);
      refuseUndeclared("body", surface, Object.keys(raw), declaredBody, new Set());
      const body = bodySchema.parse(raw) as Infer<S["body"]>;

      return { path, query, header, body };
    },
  };
}

/** `z.object(shape)` with bracketed markers unwrapped. */
function mapShape(shape: Shape): Record<string, z.ZodType> {
  return Object.fromEntries(
    Object.entries(shape).map(([name, schema]) => [name, unwrapBracketed(schema)])
  );
}

// ─── Path ────────────────────────────────────────────────────────────────────

/**
 * Split declared path-param names into router-named params and the single
 * wildcard, and prove the declaration matches the pattern in both directions.
 * A pattern segment with no declared schema, or a declared name the pattern
 * does not contain, is a declaration that has already drifted.
 */
function splitPathParams(
  surface: string,
  pattern: string,
  declared: string[]
): { named: string[]; wildcard: string | null } {
  const patternNames = [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  const wildcards = pattern.split("/").filter((segment) => segment === "*" || segment.endsWith("*"));
  if (wildcards.length > 1) {
    throw new Error(`route-inputs: ${surface} has more than one wildcard segment`);
  }
  const missing = patternNames.filter((name) => !declared.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `route-inputs: ${surface} does not declare path param${missing.length > 1 ? "s" : ""} ` +
        missing.map((name) => `'${name}'`).join(", ")
    );
  }
  const extra = declared.filter((name) => !patternNames.includes(name));
  if (wildcards.length === 0) {
    if (extra.length > 0) {
      throw new Error(
        `route-inputs: ${surface} declares path param${extra.length > 1 ? "s" : ""} ` +
          `${extra.map((name) => `'${name}'`).join(", ")} its pattern does not contain`
      );
    }
    return { named: patternNames, wildcard: null };
  }
  if (extra.length !== 1) {
    throw new Error(
      `route-inputs: ${surface} has a wildcard segment, so exactly one declared path param must ` +
        `name it (found ${extra.length}: ${extra.map((name) => `'${name}'`).join(", ") || "none"})`
    );
  }
  return { named: patternNames, wildcard: extra[0]! };
}

function readPathParams(
  request: RouteRequestSource,
  named: string[],
  wildcard: string | null,
  pattern: string
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of named) out[name] = request.param(name);
  if (wildcard) out[wildcard] = readWildcard(request, pattern, named, out);
  return out;
}

/**
 * The wildcard tail, read off the pathname rather than the router.
 *
 * hono does not expose `*` as a named param, and a session-mounted sub-app
 * cannot see the parent mount's params either — which is why every twin that
 * serves a wildcard route grew its own pathname-slicing helper. There is one
 * here instead, and it is inside the declaration, so the value a handler gets
 * still comes from the thing that declared it.
 */
function readWildcard(
  request: RouteRequestSource,
  pattern: string,
  named: string[],
  resolved: Record<string, string | undefined>
): string | undefined {
  const pathname = new URL(request.url, "http://twin.invalid").pathname;
  // Rebuild the pattern's literal prefix with the named params substituted, so
  // the tail is whatever follows it. Anything the router matched has this
  // prefix somewhere; the mount point is the part before it.
  const prefix = pattern
    .slice(0, pattern.lastIndexOf("*"))
    .replace(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?/g, (whole, name: string) =>
      named.includes(name) ? encodeURIComponent(resolved[name] ?? "") : whole
    );
  const at = pathname.indexOf(prefix);
  if (at < 0) return undefined;
  const tail = pathname.slice(at + prefix.length);
  return tail.length > 0 ? safeDecode(tail) : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ─── Query ───────────────────────────────────────────────────────────────────

function refuseUndeclared(
  location: Extract<InputLocation, "query" | "body">,
  surface: string,
  present: string[],
  declared: Set<string>,
  bracketed: Set<string>
): void {
  const offenders: string[] = [];
  for (const key of present) {
    if (declared.has(key)) continue;
    const base = key.slice(0, key.indexOf("["));
    if (key.includes("[") && bracketed.has(base)) continue;
    if (!offenders.includes(key)) offenders.push(key);
  }
  if (offenders.length > 0) throw new UndeclaredInputError(location, offenders, surface);
}

function readQuery(
  searchParams: URLSearchParams,
  declared: Set<string>,
  bracketed: Set<string>,
  arrays: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of declared) {
    if (arrays.has(name)) {
      // Repeated params (`?labelIds=A&labelIds=B`) are the array shape; an
      // absent one is an empty list, not a missing input.
      out[name] = searchParams.getAll(name);
      continue;
    }
    if (bracketed.has(name)) {
      const nested = readBracketed(searchParams, name);
      if (nested !== undefined) out[name] = nested;
      continue;
    }
    if (searchParams.has(name)) out[name] = searchParams.get(name);
  }
  return out;
}

/** `created=1` → `"1"`; `created[gte]=1&created[lt]=2` → `{gte:"1", lt:"2"}`. */
function readBracketed(searchParams: URLSearchParams, name: string): unknown {
  const flat = searchParams.get(name);
  const nested: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith(`${name}[`) || !key.endsWith("]")) continue;
    const inner = key.slice(name.length + 1, -1);
    if (inner.length > 0) nested[inner] = value;
  }
  if (Object.keys(nested).length > 0) return flat === null ? nested : { ...nested, value: flat };
  return flat === null ? undefined : flat;
}

// ─── Body ────────────────────────────────────────────────────────────────────

async function decodeBody(
  request: RouteRequestSource,
  encoding: BodyEncoding,
  surface: string,
  mediaField: string | undefined
): Promise<Record<string, unknown>> {
  if (encoding === "none") return {};
  const contentType = request.header("content-type") ?? "";
  if (encoding === "json" || encoding === "json-optional") {
    const value = await request.json().catch(() => undefined);
    if (isPlainObject(value)) return value;
    if (encoding === "json-optional") return {};
    throw new MalformedBodyError(surface);
  }
  if (encoding === "form") {
    if (contentType.includes("application/json") || contentType === "") {
      const value = await request.json().catch(() => undefined);
      if (isPlainObject(value)) return value;
      if (contentType.includes("application/json")) return {};
    }
    const form = await request.parseBody({ all: true }).catch(() => undefined);
    return form ? expandBrackets(form) : {};
  }
  return decodeMedia(request, contentType, surface, mediaField!);
}

/**
 * Gmail's three request encodings for one operation. Whichever arrives, the
 * result is a plain object keyed by DECLARED body names — the media bytes land
 * on `mediaField`, so `raw` means the same thing however it was sent.
 */
async function decodeMedia(
  request: RouteRequestSource,
  contentType: string,
  surface: string,
  mediaField: string
): Promise<Record<string, unknown>> {
  if (/^application\/json\b/i.test(contentType) || /^text\/json\b/i.test(contentType)) {
    const value = await request.json().catch(() => undefined);
    if (isPlainObject(value)) return value;
    throw new MalformedBodyError(surface);
  }
  if (/^multipart\/related\b/i.test(contentType)) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
    if (!boundary) throw new MalformedBodyError(surface);
    const parts = splitRelated(Buffer.from(await request.arrayBuffer()), boundary);
    if (parts.length !== 2) throw new MalformedBodyError(surface);
    let metadata: unknown;
    try {
      metadata = JSON.parse(parts[0]!.toString("utf8"));
    } catch {
      throw new MalformedBodyError(surface);
    }
    if (!isPlainObject(metadata)) throw new MalformedBodyError(surface);
    return setPath({ ...metadata }, mediaField, parts[1]!);
  }
  return setPath({}, mediaField, Buffer.from(await request.arrayBuffer()));
}

/** Split a `multipart/related` payload into its part bodies, headers dropped. */
function splitRelated(bytes: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`);
  const end = Buffer.from(`--${boundary}--`);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf(marker, cursor);
    if (start < 0 || bytes.subarray(start, start + end.length).equals(end)) break;
    const lineEnd = bytes.indexOf(10, start + marker.length);
    if (lineEnd < 0) break;
    const next = bytes.indexOf(marker, lineEnd + 1);
    if (next < 0) break;
    let chunk = bytes.subarray(lineEnd + 1, next);
    while (chunk.length > 0 && (chunk.at(-1) === 10 || chunk.at(-1) === 13)) {
      chunk = chunk.subarray(0, -1);
    }
    const crlf = chunk.indexOf(Buffer.from("\r\n\r\n"));
    const lf = chunk.indexOf(Buffer.from("\n\n"));
    const separator = crlf >= 0 ? { index: crlf, length: 4 } : { index: lf, length: 2 };
    if (separator.index < 0) break;
    parts.push(Buffer.from(chunk.subarray(separator.index + separator.length)));
    cursor = next;
  }
  return parts;
}

function setPath(
  target: Record<string, unknown>,
  dotted: string,
  value: unknown
): Record<string, unknown> {
  const keys = dotted.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = isPlainObject(next) ? { ...next } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys.at(-1)!] = value;
  return target;
}

/**
 * Stripe's bracket encoding: `payment_method_types[0]=card` →
 * `{ payment_method_types: ["card"] }`.
 *
 * `__proto__` / `constructor` / `prototype` paths are dropped: a form body
 * spelling one of them would otherwise mutate `Object.prototype` for the rest
 * of the process's life. They are not parameter names on any vendor surface,
 * and a dropped key is refused by the undeclared-input check right after this.
 */
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function expandBrackets(form: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(form)) {
    const segments: Array<string | number> = [];
    for (const match of rawKey.matchAll(/([^[\]]+)|\[([^[\]]*)\]/g)) {
      const piece = match[1] ?? match[2] ?? "";
      segments.push(/^\d+$/.test(piece) ? Number(piece) : piece);
    }
    if (segments.some((segment) => typeof segment === "string" && POLLUTION_KEYS.has(segment))) {
      continue;
    }
    let cursor: Record<string | number, unknown> = out;
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments[index]!;
      if (index === segments.length - 1) {
        // hono's `all: true` hands back a single-element array for a key that
        // appeared once; flatten it so `amount=1` is `"1"`, not `["1"]`.
        cursor[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
        break;
      }
      const nextKey = segments[index + 1]!;
      if (cursor[key] === undefined) cursor[key] = typeof nextKey === "number" ? [] : {};
      cursor = cursor[key] as Record<string | number, unknown>;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Wire-shaped schema vocabulary ───────────────────────────────────────────
//
// Query strings and form bodies carry strings; JSON bodies carry real types.
// These are the coercions the twins share so `?limit=10` means the same thing
// on every route, and so the derived `type` stays honest about what the wire
// actually accepts (`integer`, `boolean|string`) instead of being asserted.

/** An integer query param: `?per_page=30`. Rejects non-integers and out-of-range. */
export function integerInput(options: { min?: number; max?: number } = {}): z.ZodType<number> {
  let schema = z.coerce.number().int();
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  return schema;
}

/**
 * A boolean that accepts either a JSON boolean or the wire's `"true"`/`"false"`.
 * Any other spelling is rejected rather than silently read as false — silently
 * reading `?exclude_archived=yes` as false is the class of bug this whole
 * ticket is about.
 */
export const booleanInput: z.ZodType<boolean> = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

/** A repeated query param (`?labelIds=A&labelIds=B`), absent meaning `[]`. */
export function repeatedInput(options: { max?: number } = {}): z.ZodType<string[]> {
  const items = options.max === undefined ? z.array(z.string()) : z.array(z.string()).max(options.max);
  return items.default([]);
}

// ─── Type derivation ─────────────────────────────────────────────────────────

/**
 * The declared type, taken from the schema by way of JSON Schema.
 *
 * `io: "input"` matters: `z.coerce.number()` accepts a string on the wire, and
 * the vendor declares the type it accepts, not the type it ends up with.
 * `unrepresentable: "any"` keeps a `z.instanceof(Uint8Array)` from throwing —
 * it resolves to no type at all, which is reported as `null` rather than
 * guessed. A union collapses to its single shared type, or to the sorted
 * members joined by `|`; a guess here would be asserted against real vendor
 * types downstream.
 */
export function jsonSchemaTypeOf(schema: z.ZodType): string | null {
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
  return typeNameFromJsonSchema(json);
}

function typeNameFromJsonSchema(json: unknown): string | null {
  if (!isPlainObject(json)) return null;
  if (typeof json.type === "string") return json.type;
  if (Array.isArray(json.type)) {
    const names = json.type.filter((name): name is string => typeof name === "string" && name !== "null");
    return names.length === 1 ? names[0]! : names.length > 1 ? [...new Set(names)].sort().join("|") : null;
  }
  const branches = Array.isArray(json.anyOf) ? json.anyOf : Array.isArray(json.oneOf) ? json.oneOf : null;
  if (!branches) return null;
  const names = new Set<string>();
  for (const branch of branches) {
    const name = typeNameFromJsonSchema(branch);
    // `null` is how zod spells `.nullable()`; it is not a type the vendor
    // declares, so it never decides the answer on its own.
    if (name && name !== "null") names.add(name);
  }
  if (names.size === 0) return null;
  return [...names].sort().join("|");
}

// ─── Published surface ───────────────────────────────────────────────────────

export const declaredInputSchema = z.strictObject({
  name: z.string().min(1),
  location: z.enum(["path", "query", "header", "body", "argument"]),
  required: z.boolean(),
  type: z.string().min(1).nullable(),
});

export const routeInputSurfaceSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"]),
  path: z.string().min(1),
  surface: z.string().min(1),
  inputs: z.array(declaredInputSchema).min(1),
});

/**
 * One GraphQL root field's argument surface. Keyed `GQL <rootField>`, which is
 * the identity pome-cloud's GraphQL adapter already uses (`GQL_PREFIX`), so the
 * two sides need no translation table.
 */
export const graphqlArgumentSurfaceSchema = z.strictObject({
  surface: z.string().min(1),
  root: z.enum(["query", "mutation"]),
  inputs: z.array(declaredInputSchema).min(1),
});

/**
 * The shape of each twin's `route-inputs.json` — the artifact pome-cloud reads
 * through its existing checkout seam (`POME_TWIN_SRC`).
 *
 * `source` and `generated_by` are there so a reader can tell it is derived and
 * how to re-derive it; `emit-route-inputs.mjs --check` in CI is what stops a
 * stale copy merging. Nothing here is hand-maintained.
 */
export const routeInputArtifactSchema = z.strictObject({
  twin: z.string().min(1),
  package: z.string().min(1),
  artifact_version: z.literal(1),
  generated_by: z.string().min(1),
  source: z.array(z.string().min(1)).min(1),
  /** Surfaces with at least one declared input; a zero-input surface is
   *  omitted, because an empty declaration compares empty against empty and
   *  reports a match nobody measured. */
  surface_count: z.number().int().nonnegative(),
  input_count: z.number().int().nonnegative(),
  surfaces: z.array(routeInputSurfaceSchema),
  /**
   * Present only for a twin whose non-MCP API layer is GraphQL. Same
   * omit-when-empty rule as `surfaces`: a root field with no arguments is left
   * out rather than published with `[]`.
   */
  graphql_surfaces: z.array(graphqlArgumentSurfaceSchema).optional(),
});
export type RouteInputArtifact = z.infer<typeof routeInputArtifactSchema>;
export type GraphqlArgumentSurface = z.infer<typeof graphqlArgumentSurfaceSchema>;

/**
 * Project declarations into the published artifact.
 *
 * Surfaces with no declared inputs are dropped rather than emitted with an
 * empty list. pome-cloud's comparator counts an empty declaration as
 * `empty-declaration` — a non-result — precisely so that comparing nothing
 * against nothing never renders as a pass; emitting `[]` would ask it to.
 */
export function buildRouteInputArtifact(input: {
  twin: string;
  package: string;
  generatedBy: string;
  source: string[];
  declarations: readonly RouteInputDeclaration[];
  graphql?: readonly GraphqlArgumentSurface[];
}): RouteInputArtifact {
  const surfaces = input.declarations
    .filter((declaration) => declaration.inputs.length > 0)
    .map((declaration) => ({
      method: declaration.method,
      path: declaration.path,
      surface: declaration.surface,
      inputs: declaration.inputs.map((declared) => ({ ...declared })),
    }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
  const graphql = (input.graphql ?? [])
    .filter((entry) => entry.inputs.length > 0)
    .map((entry) => ({ ...entry, inputs: entry.inputs.map((declared) => ({ ...declared })) }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
  return routeInputArtifactSchema.parse({
    twin: input.twin,
    package: input.package,
    artifact_version: 1,
    generated_by: input.generatedBy,
    source: input.source,
    surface_count: surfaces.length + graphql.length,
    input_count:
      surfaces.reduce((total, surface) => total + surface.inputs.length, 0) +
      graphql.reduce((total, surface) => total + surface.inputs.length, 0),
    surfaces,
    ...(graphql.length > 0 ? { graphql_surfaces: graphql } : {}),
  });
}

/**
 * Fail loudly when a router's registered routes and a twin's exported
 * declarations are not the same set.
 *
 * The declaration is what the route is registered WITH, so the two cannot
 * disagree about a route's method or path. They can still disagree about
 * EXISTENCE — a route registered without one, or a declaration nothing mounts —
 * and either would put a hole in the published surface while every other check
 * stayed green.
 */
export function diffRegisteredRoutes(
  registered: readonly string[],
  declared: readonly RouteInputDeclaration[]
): { undeclared: string[]; unmounted: string[]; duplicated: string[] } {
  const declaredSurfaces = declared.map((declaration) => declaration.surface);
  const declaredSet = new Set(declaredSurfaces);
  const counts = new Map<string, number>();
  for (const surface of declaredSurfaces) counts.set(surface, (counts.get(surface) ?? 0) + 1);
  const mounted = new Set(registered);
  return {
    undeclared: [...new Set(registered)].filter((surface) => !declaredSet.has(surface)).sort(),
    unmounted: declaredSurfaces.filter((surface) => !mounted.has(surface)).sort(),
    duplicated: [...counts.entries()].filter(([, count]) => count > 1).map(([surface]) => surface).sort(),
  };
}
