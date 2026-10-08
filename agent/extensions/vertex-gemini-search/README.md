# vertex-gemini-search

Web search and research tools backed by Vertex AI Gemini with Google Search grounding.

Vendored from [`@nilskluewer/pi-vertex-gemini-search`](https://github.com/nilskluewer/pi-vertex-gemini-search) (MIT, see `LICENSE`) and adapted to this repository; it is not synced with upstream.

## Tools

- **`web_search`**: quick fact-check or verification. Returns a concise answer and source URLs.
- **`web_research`**: in-depth research on complex topics. Returns a structured answer and source URLs.

Both ground answers with Google Search, read URLs passed in the query via Gemini `url_context`, resolve `vertexaisearch.cloud.google.com` redirects to their destinations, and prefix results with a model/cost/pricing-tier summary.

## Vertex AI setup

Requests always use Sheer Health's Vertex project and location from `VERTEX_ENV` in `../shared/accounts.ts`, in every profile (`google-vertex` is a shared account). Unlike upstream, `VERTEX_PROJECT_ID`, `VERTEX_REGION`, `VERTEX_ACCESS_TOKEN`, and the other upstream env overrides are ignored, so ambient env cannot redirect traffic outside the ZDR/BAA project.

Authentication uses the same gcloud Application Default Credentials file as the `google-vertex` provider (`$GOOGLE_APPLICATION_CREDENTIALS`, else `~/.config/gcloud/application_default_credentials.json`). If it is missing or expired:

```sh
gcloud auth application-default login
```

Both tools use `gemini-3.8-flash`, the only Gemini model the model-control blacklist allows. Token rates come from the `google-vertex` model catalog; Google Search grounding is estimated at $14 per 1,000 queries.

## Pricing tier

```text
/search-pricing            # show the current preference
/search-pricing standard   # default
/search-pricing flex       # Flex PayGo, falling back to standard
```

Standard is the default because Flex requests queue until they time out on this project, and grounding dominates the cost of a search. A Flex timeout or an unsupported-Flex 400 falls back to standard immediately. The preference does not persist across Pi sessions.
