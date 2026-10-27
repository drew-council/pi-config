# Model policy

Chat models retain the existing profile provider restrictions and `MODEL_BLACKLIST`.
An omitted model `type` means chat, as in Pi's provider configuration. Unknown
model types fail closed.

`NON_CHAT_ALLOWLISTS` explicitly defines separate classifier and image allowlists
for work and personal. Each entry is authorized by user decision:

| Profile | Classifier | Why |
|---|---|---|
| work | `fireworks/accounts/fireworks/models/rune` | Work Fireworks key. pi-sheer's `fireworks-rune` extension adds the model. |
| personal | `openrouter/typesafe/jev-1.14` | Personal OpenRouter key; the account is ZDR-only and OpenRouter lists TypeSafe's endpoint as ZDR. |

Both image lists are empty. Every other non-chat model stays disabled; do not
fall back to a chat model, another version, a router alias, or another provider.

Catalog presence does not authorize a model. TypeSafe direct, Google AI Studio,
Cloudflare, llama.cpp and other disabled providers remain disabled. Work data
must not be sent through personal OpenRouter or any other personal service; the
existing Vertex ZDR/BAA boundary and profile-specific credentials remain
unchanged. No credentials, chat defaults, or approval behavior are changed by
this policy.

The same policy applies to typed and combined catalog discovery, model-object
authentication, and actual `classify`/`generateImages` runtime entrypoints used by
extensions and codemode. Execution authorizes the requested operation rather
than trusting the supplied model type, credentials override, prior discovery,
or retained model reference. Denied execution returns Pi-shaped error results
(or aborted results for an already-cancelled signal), without reaching auth or
a provider. Reload updates callbacks without stacking wrappers and installs the
typed guards even when a live session retains older chat-only policy wrappers.

Tests use fixture catalogs and the loaded Pi runtime APIs, never real classifier
or image requests. This extension is a runtime policy, not a sandbox against
trusted extensions deliberately accessing providers directly or removing guards.

## Startup refresh compatibility (Pi 1.0.4)

Keep `installSerialRefresh`: Pi 0.99.2's startup fix provisionally enables an
extension provider only when its credential was already in the initial
snapshot's `storedProviders` (or its registration config supplies auth). Our
extension binds `auth.json` to the active profile after that snapshot was read.
The profile credential is therefore not yet known to the provisional update.
Pi 1.0.4 still drops superseded availability passes; an awaited service refresh
can return before a slower fire-and-forget registration refresh publishes.
Without serialization, default selection and restored branch selection can
both see an unavailable provider despite the profile's stored credential.

`agent/tests/extensions/model-control-startup-refresh.test.ts` executes the
synced Pi host's service construction, native/config extension registration,
file-backed profile binding, availability publication and session selection.
Deterministic gates reproduce the race without serialization and verify both
startup paths with it. A separate case verifies the upstream fix works when the
credential really was in the original store. Tests use temporary fixture keys,
no built-in providers, no model requests and no network catalog refreshes.

The workaround remains per-runtime, reload-idempotent and bounded by the
existing 30-second queue wait. That escape hatch does not promise publication
when a preceding refresh is wedged; it is intentionally unchanged. Revisit
removal only when the host guarantees awaited publication across credential
rebinding and overlapping registration refreshes, not just provisional auth.
