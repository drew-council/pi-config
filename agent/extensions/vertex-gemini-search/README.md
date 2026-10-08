# vertex-gemini-search

Web search and research tools backed by Vertex AI Gemini with Google Search grounding.

Vendored from [`@nilskluewer/pi-vertex-gemini-search`](https://github.com/nilskluewer/pi-vertex-gemini-search) (MIT, see `LICENSE`) and adapted to this repository; it is not synced with upstream.

## Tools

- **`web_search`**: quick fact-check or verification. Returns a concise answer and source URLs.
- **`web_research`**: in-depth research on complex topics. Returns a structured answer and source URLs.

Both ground answers with Google Search, read URLs passed in the query via Gemini `url_context`, and resolve `vertexaisearch.cloud.google.com` redirects to their destinations. The model receives the answer and source URLs; codemode scripts receive structured results (`answer`, `sources`, `searchQueries`, `model`, `location`, `serviceTier`, `costUsd`). Answers stream into the transcript while Gemini writes them, and finished results show a model/cost/pricing-tier summary with a collapsed preview of the answer.

Each result reports its token and grounding cost as tool usage, so searches count toward the session cost in the footer.

## Vertex AI setup

Requests go through Pi's `google-vertex` provider with the active profile's stored credential, the same path Vertex chat models use. `google-vertex` is a shared account, and model-control pins it in every profile to Sheer Health's project and the gcloud Application Default Credentials file (see `VERTEX_ENV` in `../shared/accounts.ts`). The extension refuses to search unless that pin is in place, so ambient `GOOGLE_CLOUD_*` env vars cannot redirect traffic outside the ZDR/BAA project. Unlike upstream, it ignores `VERTEX_PROJECT_ID`, `VERTEX_ACCESS_TOKEN`, and the other upstream env overrides.

If searches report missing credentials:

```sh
gcloud auth application-default login
```

Then run `/log-me-in` and choose Google Vertex AI to recheck the pin.

Both tools use `gemini-3.8-flash`, the only Gemini model the model-control blacklist allows. Pi prices tokens from the `google-vertex` model catalog; Google Search grounding is estimated at $14 per 1,000 queries.

## Pricing tier

```text
/search-pricing            # show the current preference
/search-pricing standard   # default
/search-pricing flex       # Flex PayGo, falling back to standard
```

Standard is the default because Flex requests have queued until they time out on this project, and grounding dominates the cost of a search. When a Flex request fails or times out, the search is retried at standard and later searches stay on standard until `/search-pricing flex` is run again. The preference does not persist across Pi sessions.
