---
name: google-aip
description: API design guidance, reviews, and design-discovery questions grounded in Google's API Improvement Proposals (google.aip.dev/general).
disable-model-invocation: true
source:
  git: https://github.com/aip-dev/google.aip.dev
  path: aip/general
  into: references
---

# Google API Improvement Proposals (AIP) Guidance

Use this skill to design APIs, critique existing or proposed API surfaces, and interview the user about open API design decisions using the General corpus from [google.aip.dev/general](https://google.aip.dev/general).

All General AIP Markdown documents are materialized in `{{skillDir}}/references/` (`0001.md` through `0236.md`, plus `scope.yaml`).

## How to Use the Reference Corpus

1. **Always read the relevant AIP files before giving detailed guidance or review feedback.** Use the catalog below to pick the 2–6 AIPs that govern the topic at hand and read `{{skillDir}}/references/<dddd>.md`.
2. **Follow relative cross-references.** Each AIP links to related AIPs at the bottom of the file (for example, `[AIP-158]: ./0158.md`); resolve `./<dddd>.md` against `{{skillDir}}/references/`.
3. **Search when a topic spans multiple AIPs.** Run `grep` across `{{skillDir}}/references/` for specific terms (`etag`, `idempotency`, `allow_missing`, `validate_only`, `unreachable`, `field_mask`, status codes, etc.).

## Adapting AIPs to the Target Stack

Google's AIP examples are written in Protocol Buffers and gRPC (`google.api.http`, `google.protobuf.FieldMask`, `google.longrunning.Operation`, `google.rpc.Status`). Per the AIP FAQ, **apply the architectural and semantic rules to whatever stack the codebase uses**, and only enforce Protobuf-specific syntax when working on `.proto` / gRPC / Connect definitions:

| AIP Concept | Protobuf / gRPC | REST / JSON / OpenAPI / TypeScript / RPC |
|---|---|---|
| **Resource-oriented design (`AIP-121`)** | Service RPCs over resource messages | Nouns (resources & collections) with standard verbs; decouple public schema from DB tables |
| **Resource names & IDs (`AIP-122`)** | `publishers/{publisher}/books/{book}` in `string name` | Canonical hierarchical paths (`/v1/publishers/{publisher}/books/{book}`) or consistent resource `id`/`name` fields; never embed full sub-resources where references belong |
| **Standard methods (`AIP-131`–`AIP-135`)** | `Get`, `List`, `Create`, `Update`, `Delete` RPCs | `GET` item, `GET` collection, `POST` collection, `PATCH` item, `DELETE` item returning consistent resource schemas |
| **Custom methods (`AIP-136`)** | `POST /v1/{name=...}:archive` | Prefer state fields (`AIP-216`) or sub-resources first; when a custom verb is required, use `POST` with an action suffix or action sub-path (`:archive` / `/archive`), never custom HTTP verbs |
| **Partial updates (`AIP-134`, `AIP-161`)** | `update_mask` (`google.protobuf.FieldMask`) | `PATCH` with explicit partial-update semantics (JSON Merge Patch or field mask); never require callers to resend the full resource just to change one field |
| **Pagination (`AIP-158`)** | `page_size` + opaque `page_token` -> `next_page_token` | Cursor-based pagination (`page_size`/`limit` + opaque `page_token`/`cursor`) from day one on every collection; avoid offset pagination on mutable collections |
| **Long-running operations (`AIP-151`, `AIP-152`)** | `google.longrunning.Operation` | Return `202 Accepted` with an Operation resource (`id`, `done`, `metadata`, `response`/`error`) or model repeatable tasks as `Job` resources (`AIP-152`) |
| **Idempotency & concurrency (`AIP-154`, `AIP-155`)** | `etag` field + `request_id` UUID | `etag` / `If-Match` for optimistic concurrency (`AIP-154`); `request_id` / `Idempotency-Key` on non-idempotent mutations (`AIP-155`) |
| **Field behavior (`AIP-203`)** | `google.api.field_behavior` annotations | Document and type fields explicitly as required, optional, output-only (`readOnly`), input-only (`writeOnly`), immutable, or unordered |
| **Time & quantities (`AIP-141`, `AIP-142`)** | `Timestamp`, `Duration`, unit-suffixed fields | RFC 3339 UTC strings (`create_time`, `expire_time`) and explicit unit suffixes (`size_bytes`, `timeout_seconds`) |
| **Errors (`AIP-193`, `AIP-211`)** | `google.rpc.Status` + `ErrorInfo` | Canonical status codes + machine-readable error `reason`/`domain`/`metadata` details; check authorization before request validation (`AIP-211`) |

## Operational Modes

### 1. Asking Questions / Design Discovery

When the user asks you to help flesh out an API, stress-test a proposal, or ask clarifying questions:

- Inspect the existing codebase/spec first so you never ask questions the code already answers.
- Walk the design decision tree across the core AIP axes, prioritizing unsettled prerequisites first:
  1. **Resource model & hierarchy (`AIP-121`, `AIP-122`, `AIP-124`, `AIP-156`)**: What are the nouns? Are any resources singletons (`AIP-156`)? Does every resource have a single canonical parent, or are there many-to-one / many-to-many references (`AIP-124`)? Are identifiers server-generated or user-specified (`AIP-122`, `AIP-133`)?
  2. **Methods & state transitions (`AIP-130`–`AIP-136`, `AIP-216`)**: Which standard CRUD methods exist? Can proposed RPC-style actions (`cancel`, `enable`, `publish`, `approve`) be modeled as state transitions (`AIP-216`) or sub-resources instead of custom methods (`AIP-136`)?
  3. **Asynchrony & batching (`AIP-151`, `AIP-152`, `AIP-231`–`AIP-235`)**: Can any write take more than a couple of seconds (requiring an LRO `AIP-151` or `Job` `AIP-152`)? If batch operations exist, must they be atomic or support partial failure (`AIP-231`–`AIP-235`)?
  4. **Collection semantics (`AIP-132`, `AIP-157`–`AIP-160`, `AIP-217`)**: What are default/max page sizes (`AIP-158`)? Do callers need filtering (`AIP-160`), sorting (`AIP-132`), cross-parent listing (`AIP-159`), or summary vs. full views (`AIP-157`)?
  5. **Concurrency, retries & validation (`AIP-154`, `AIP-155`, `AIP-163`, `AIP-194`)**: Can concurrent writers clobber each other without `etag` (`AIP-154`)? Do creates/custom actions need idempotency keys (`AIP-155`) or dry-run validation (`validate_only`, `AIP-163`)?
  6. **Lifecycle, deletion & compatibility (`AIP-135`, `AIP-162`, `AIP-164`, `AIP-180`, `AIP-214`)**: Is deletion permanent, soft-delete with `Undelete` (`AIP-164`), TTL-based (`expire_time`, `AIP-214`), or cascading (`force`, `AIP-135`)? Are revisions needed (`AIP-162`)?
- For each question, briefly cite the relevant AIP and state the AIP-recommended default so the user can accept or override it quickly.

### 2. Reviewing / Giving Feedback on an API

When reviewing an API definition, PR, schema, or implementation:

- Read the applicable AIPs in `{{skillDir}}/references/` before writing the review.
- Organize findings by severity:
  1. **Contract & evolution hazards**: Unpaginated list endpoints (`AIP-158`), backwards-incompatible changes (`AIP-180`), boolean flags instead of extensible state enums (`AIP-126`, `AIP-216`), leaky database schemas (`AIP-121`), missing idempotency/concurrency protection (`AIP-154`, `AIP-155`), or validation errors that leak resource existence before auth checks (`AIP-211`).
  2. **Resource & method design**: Custom verbs where standard methods fit (`AIP-121`, `AIP-136`), inconsistent resource shapes across `Get`/`List`/`Create`/`Update` (`AIP-121`), missing `Get` or `List`, `PUT` full-replacement traps instead of partial `PATCH` (`AIP-134`), or blocking methods that should be LROs (`AIP-151`).
  3. **Fields, naming & polish**: Ambiguous field names (`AIP-140`, `AIP-148`), unitless numbers (`AIP-141`), non-standard timestamps/durations (`AIP-142`), non-ISO codes (`AIP-143`), single fields dual-purposed for user input and server-computed state (`AIP-129`), or vague error responses (`AIP-193`).
- For every finding:
  - Cite the AIP number and requirement level (**MUST**, **SHOULD**, **MAY**).
  - Explain the **rationale** (what breaks for clients or future maintainers if ignored).
  - Provide a concrete before/after snippet idiomatic to the repo's stack.
- Balance strictness with **`AIP-200` (Precedent)**: if the codebase already has an established local convention, note the AIP trade-off and distinguish between harmless local style differences and beta/GA-blocking usability hazards (`AIP-205`).

### 3. Answering Specific API Design Questions

- Read the primary AIP(s) from `{{skillDir}}/references/`.
- Give a direct recommendation first, cite the governing AIPs, explain the trade-offs/exceptions documented in the AIP's `## Guidance` and `## Rationale` sections, and show an idiomatic example.

---

## General AIP Reference Catalog (`{{skillDir}}/references/`)

### Meta & Process
- `{{skillDir}}/references/0001.md` — **AIP-1: AIP Purpose and Guidelines**: Why AIPs exist, states (`draft`, `reviewing`, `approved`), and governance.
- `{{skillDir}}/references/0002.md` — **AIP-2: AIP Numbering**: General block (`1–999`) vs. product-area blocks (`2500+`) and internal `9000+` block.
- `{{skillDir}}/references/0003.md` — **AIP-3: AIP Versioning**: Date-based evolution of AIP guidance.
- `{{skillDir}}/references/0008.md` — **AIP-8: AIP Style and Guidance**: RFC 2119 requirement keywords (`MUST`, `SHOULD`, `MAY`) and designing for broad client ecosystems.
- `{{skillDir}}/references/0009.md` — **AIP-9: Glossary**: Definitions of service, interface, method, resource, consumer, producer, and declarative client.
- `{{skillDir}}/references/0100.md` — **AIP-100: API Design Review FAQ**: How API design reviews work, handling precedent, and resolving design trade-offs.
- `{{skillDir}}/references/0200.md` — **AIP-200: Precedent**: When local/existing API consistency justifies deviating from an AIP, and when it does not.
- `{{skillDir}}/references/0205.md` — **AIP-205: Beta-blocking changes**: Usability and standard violations that must be fixed before promoting an Alpha API to Beta/GA.

### API Concepts & Resource Design
- `{{skillDir}}/references/0111.md` — **AIP-111: Planes**: Management plane vs. data plane distinctions (scale, latency, consistency, declarative friendliness).
- `{{skillDir}}/references/0121.md` — **AIP-121: Resource-oriented design**: Core model: resources (nouns), acyclic hierarchies, standard methods, matching resource schemas across methods, strong consistency on management plane, stateless requests.
- `{{skillDir}}/references/0122.md` — **AIP-122: Resource names**: Collection identifiers (plural `camelCase`), resource ID segments, full resource names, `name` vs. `parent` vs. `*_id`, referring to other resources by name instead of embedding them.
- `{{skillDir}}/references/0123.md` — **AIP-123: Resource types**: Canonical `{Service}/{Type}` resource type names, singular/plural definitions, message alignment.
- `{{skillDir}}/references/0124.md` — **AIP-124: Resource association**: Single canonical parent rule, multiple many-to-one references, and sub-resources/association resources for many-to-many relationships.
- `{{skillDir}}/references/0126.md` — **AIP-126: Enumerations**: `UPPER_SNAKE_CASE`, mandatory `*_UNSPECIFIED = 0` zero value, when to use enums vs. strings (`AIP-143`) or booleans.
- `{{skillDir}}/references/0128.md` — **AIP-128: Declarative-friendly interfaces**: Requirements for IaC/declarative tools (user-settable IDs, `etag`, `allow_missing`, LROs, no custom methods).
- `{{skillDir}}/references/0129.md` — **AIP-129: Server-Modified Values and Defaults**: Handling server defaults, dynamic defaults (separate `effective_*` output-only fields), and input normalization.
- `{{skillDir}}/references/0156.md` — **AIP-156: Singleton resources**: Resources with exactly one instance per parent (e.g., `Settings`, `Config`); supports `Get` and `Update`, omits `Create`/`Delete`/`List`.
- `{{skillDir}}/references/0236.md` — **AIP-236: Policy preview**: Previewing/simulating policy changes (`live` vs. `preview` policy fields, dry-run evaluation).

### Operations: Standard, Custom & Batch Methods
- `{{skillDir}}/references/0130.md` — **AIP-130: Methods**: Choosing between standard methods, custom methods, and batch methods.
- `{{skillDir}}/references/0131.md` — **AIP-131: Standard methods: Get**: Retrieving a single resource by `name`; `GET`, no side effects, returns the resource itself.
- `{{skillDir}}/references/0132.md` — **AIP-132: Standard methods: List**: Listing a collection (`parent`, `page_size`, `page_token`, optional `filter` and `order_by`); response has plural resource field + `next_page_token`.
- `{{skillDir}}/references/0133.md` — **AIP-133: Standard methods: Create**: Creating a resource (`parent`, `book`, optional `book_id`); `POST`, returns the created resource (or LRO).
- `{{skillDir}}/references/0134.md` — **AIP-134: Standard methods: Update**: Partial updates via `PATCH` + `update_mask` (field mask); `allow_missing` for upsert; returns updated resource (or LRO).
- `{{skillDir}}/references/0135.md` — **AIP-135: Standard methods: Delete**: Deleting a resource by `name`; `DELETE`, returns `Empty` (or resource for soft-delete, or LRO); `allow_missing`, `etag`, `force` for cascading delete.
- `{{skillDir}}/references/0136.md` — **AIP-136: Custom methods**: `POST /v1/{name=...}:<verb>` for actions that cannot map to standard CRUD; verb naming (`ArchiveBook`, no prepositions), resource vs. collection vs. stateless custom methods.
- `{{skillDir}}/references/0151.md` — **AIP-151: Long-running operations**: Async operations returning an `Operation` with `response` and `metadata` types, polling, cancellation, expiration, and errors.
- `{{skillDir}}/references/0231.md` — **AIP-231: Batch methods: Get**: `BatchGet<Plural>` (`GET /v1/{parent=...}/books:batchGet`), atomic retrieval of up to a fixed number of resources.
- `{{skillDir}}/references/0233.md` — **AIP-233: Batch methods: Create**: `BatchCreate<Plural>` (`POST .../books:batchCreate`), atomic vs. partial success patterns.
- `{{skillDir}}/references/0234.md` — **AIP-234: Batch methods: Update**: `BatchUpdate<Plural>` (`POST .../books:batchUpdate`), nested `UpdateBookRequest` items, atomic vs. partial success.
- `{{skillDir}}/references/0235.md` — **AIP-235: Batch methods: Delete**: `BatchDelete<Plural>` (`POST .../books:batchDelete`), atomic vs. partial success, soft-delete responses.

### Fields
- `{{skillDir}}/references/0140.md` — **AIP-140: Field names**: ` lower_snake_case`, American English, no prepositions (`for`, `during`, `at`, `with`), avoid abbreviations (`config`, `id`, `spec`, `stats` allowed), boolean `has_`/`is_` rules, `uri` over `url`.
- `{{skillDir}}/references/0141.md` — **AIP-141: Quantities**: Always suffix numeric quantities with the plural unit (`size_bytes`, `distance_miles`, ` node_count`); prefer `int64` over `uint64` and `double` over `float`.
- `{{skillDir}}/references/0142.md` — **AIP-142: Time and duration**: `Timestamp` with `*_time` suffix (never `*_date` or `*_at`), `Duration` or unit-suffixed integers, civil `Date`/`TimeOfDay`/`DateTime` + IANA time zone.
- `{{skillDir}}/references/0143.md` — **AIP-143: Standardized codes**: Use string fields for MIME `content_type` / `mime_type`, Unicode CLDR `region_code` (not `country`), ISO-4217 `currency_code`, BCP-47 `language_code`, IANA `time_zone`.
- `{{skillDir}}/references/0144.md` — **AIP-144: Repeated fields**: Prefer repeated messages over parallel arrays or scalar lists when elements may grow attributes; helper strategies for updating repeated fields.
- `{{skillDir}}/references/0145.md` — **AIP-145: Ranges**: Half-open `[start_*, end_*)` intervals (`start_time`/`end_time`, `start_offset`/`end_offset`); inclusive only for dates.
- `{{skillDir}}/references/0146.md` — **AIP-146: Generic fields**: Trade-offs between `oneof`, `map<string, string>`, `Struct`, and `Any`; avoid untyped blobs when schemas are known.
- `{{skillDir}}/references/0147.md` — **AIP-147: Sensitive fields**: Handling secrets/keys via `INPUT_ONLY` fields, dedicated custom methods, or separate secret resources.
- `{{skillDir}}/references/0148.md` — **AIP-148: Standard fields**: Standard names and semantics for `name`, `uid`, `display_name`, `title`, `description`, `create_time`, `update_time`, `delete_time`, `expire_time`, `etag`, `labels`, `annotations`.
- `{{skillDir}}/references/0149.md` — **AIP-149: Unset field values**: Distinguishing unset/null from zero-value defaults (`optional` presence tracking) and avoiding nullable wrapper types.
- `{{skillDir}}/references/0202.md` — **AIP-202: Fields**: Enriching string/bytes fields with semantic format metadata (`UUID4`, `IPV4`, `IPV6`, `IPV4_OR_IPV6`).
- `{{skillDir}}/references/0203.md` — **AIP-203: Field behavior documentation**: Semantics of `REQUIRED`, `OPTIONAL`, `OUTPUT_ONLY`, `INPUT_ONLY`, `IMMUTABLE`, `IDENTIFIER`, and `UNORDERED_LIST` (including ignoring `OUTPUT_ONLY` fields in requests rather than erroring).
- `{{skillDir}}/references/0216.md` — **AIP-216: States**: Lifecycle `State` enum (`CREATING`, `ACTIVE`, `UPDATING`, `DELETING`, `DELETED`, `FAILED`, `SUSPENDED`), output-only `state` field, state transition methods.

### Design Patterns
- `{{skillDir}}/references/0152.md` — **AIP-152: Jobs**: Modeling recurring or re-runnable long-running tasks as a `Job` resource with a `:run` custom method returning an LRO.
- `{{skillDir}}/references/0153.md` — **AIP-153: Import and export**: `:import` and `:export` custom methods, source/destination config `oneof`, inline vs. external storage, LRO handling.
- `{{skillDir}}/references/0154.md` — **AIP-154: Resource freshness validation**: Optimistic concurrency via `etag` (strong vs. weak), `ABORTED` (`409`) on mismatch.
- `{{skillDir}}/references/0155.md` — **AIP-155: Request identification**: Idempotency via `request_id` (UUID4); deduplicating retries and returning cached response on duplicate request IDs.
- `{{skillDir}}/references/0157.md` — **AIP-157: Partial responses**: Resource `View` enums (`BASIC`, `FULL`) vs. read field masks for large or expensive fields.
- `{{skillDir}}/references/0158.md` — **AIP-158: Pagination**: `page_size` and opaque `page_token` on requests, `next_page_token` and optional `total_size` on responses, optional `skip`.
- `{{skillDir}}/references/0159.md` — **AIP-159: Reading across collections**: Supporting `-` wildcard in parent segments (`publishers/-/books`) for cross-parent `List` and `Get`.
- `{{skillDir}}/references/0160.md` — **AIP-160: Filtering**: Structured `string filter` expressions (`AND`, `OR`, `NOT`, comparisons, `:` has operator, field traversal).
- `{{skillDir}}/references/0161.md` — **AIP-161: Field masks**: Wildcards, nested field paths, map key masks, and invalid mask handling.
- `{{skillDir}}/references/0162.md` — **AIP-162: Resource Revisions**: Revision history via `@<revision_id>` syntax or nested `revisions` subcollections, tagging, rollback, and deleting revisions.
- `{{skillDir}}/references/0163.md` — **AIP-163: Change validation**: `bool validate_only` on mutating requests for dry-run validation without side effects.
- `{{skillDir}}/references/0164.md` — **AIP-164: Soft delete**: Retaining deleted resources with `DELETED` state and `expire_time`, `show_deleted` on `List`, `:undelete` and `:expunge` methods.
- `{{skillDir}}/references/0165.md` — **AIP-165: Criteria-based delete**: `: purge` custom method (`filter` + `force` dry-run safety flag) when deleting resources by filter criteria.
- `{{skillDir}}/references/0210.md` — **AIP-210: Unicode**: UTF-8 encoding, NFC normalization, measuring lengths in Unicode code points or UTF-8 bytes, identifier character restrictions.
- `{{skillDir}}/references/0211.md` — **AIP-211: Authorization checks**: Check permissions before input validation to prevent resource-existence timing/error leaks; `PERMISSION_DENIED` vs. `NOT_FOUND`.
- `{{skillDir}}/references/0214.md` — **AIP-214: Resource expiration**: `expire_time` (`Timestamp`) + input-only `ttl` (`Duration`) `oneof` for automatic resource expiration.
- `{{skillDir}}/references/0217.md` — **AIP-217: Unreachable resources**: `repeated string unreachable` and `return_partial_success` when listing across regions/shards with partial outages.

### Compatibility & Versioning
- `{{skillDir}}/references/0180.md` — **AIP-180: Backwards compatibility**: Source, wire, and semantic compatibility rules: what changes are safe vs. breaking across API evolutions.
- `{{skillDir}}/references/0181.md` — **AIP-181: Stability levels**: Alpha / Experimental, Beta / Preview, and GA expectations for stability, support, and deprecation windows.
- `{{skillDir}}/references/0182.md` — **AIP-182: External software dependencies**: Versioning and lifecycle rules when a resource exposes third-party software versions.
- `{{skillDir}}/references/0184.md` — **AIP-184: API version identifiers**: Major (`v1`), beta (`v1beta1`), and alpha (`v1alpha`) version identifier formats and ordering.
- `{{skillDir}}/references/0185.md` — **AIP-185: API Versioning**: Channel-based, interface-based, release-based, and visibility-based versioning strategies.

### Polish & Error Handling
- `{{skillDir}}/references/0190.md` — **AIP-190: Naming conventions**: Service, interface, method (`UpperCamelCase` verb+noun), message, and enum naming conventions.
- `{{skillDir}}/references/0191.md` — **AIP-191: File and directory structure**: Package naming, directory layout, and language-specific packaging options (Protobuf).
- `{{skillDir}}/references/0192.md` — **AIP-192: Documentation**: Writing clear API comments: third-person declarative style, constraints, units, cross-references, and deprecation notices.
- `{{skillDir}}/references/0193.md` — **AIP-193: Errors**: Canonical error codes, actionable developer `message`, structured `ErrorInfo` (`reason`, `domain`, `metadata`), `LocalizedMessage`, and partial errors.
- `{{skillDir}}/references/0194.md` — **AIP-194: Automatic retry configuration**: Which methods and status codes (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) are safe for automatic client retry vs. non-retryable.

### Protocol Buffers (When Working with `.proto` / gRPC)
- `{{skillDir}}/references/0127.md` — **AIP-127: HTTP and gRPC Transcoding**: `google.api.http` path bindings, query parameters, `body` mappings, and `additional_bindings`.
- `{{skillDir}}/references/0213.md` — **AIP-213: Common components**: Using well-known `google.protobuf.*` and `google.type.*` messages (`Date`, `Money`, `LatLng`, `Interval`, `PostalAddress`).
- `{{skillDir}}/references/0215.md` — **AIP-215: API-specific protos**: Keeping API proto packages self-contained within a versioned package namespace.
