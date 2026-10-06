# Model policy

Chat models retain the existing profile provider restrictions and `MODEL_BLACKLIST`.
An omitted model `type` means chat, as in Pi's provider configuration. Unknown
model types fail closed.

`NON_CHAT_ALLOWLISTS` explicitly defines separate classifier and image allowlists
for work and personal. **Both lists are empty in both profiles by user decision.**
The capability infrastructure is installed, but every non-chat model is intentionally
disabled pending explicit authorization. This is not a catalog defect; do not
fall back to a chat model or another provider.

Pi 1.0.4's bundled catalogs expose classifier and image models through OpenRouter
(the only currently allowed provider with bundled non-chat entries). This does
not authorize them. TypeSafe direct, Google AI Studio, Cloudflare, llama.cpp and
other disabled providers remain disabled. Work data must not be sent through
personal OpenRouter or any other personal service; the existing Vertex ZDR/BAA
boundary and profile-specific credentials remain unchanged. No providers,
credentials, chat defaults, or approval behavior are changed by this policy.

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
