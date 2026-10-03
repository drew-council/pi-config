# Composio for Pi

Native Pi tools built with `@composio/experimental`'s `PiProvider`. The provider's
capability interface is adapted to Composio For You's hosted MCP service so it
uses the apps already connected in the consumer dashboard. A Platform SDK key
and a For You consumer key are different credentials.

## Use

- `/composio` or `/composio on`: connect and activate the tools for this session.
- `/composio off`: deactivate tools and close the connection.
- `/composio status`: show whether the connector is attached.

The final configuration is off by default, with no Composio network requests or
secret reads until the slash command. The footer displays `Composio connected`
after authentication and tool discovery succeed. Starting, resuming, forking, or
reloading a session requires enabling it again. The agent cannot enable it by
calling a tool; both tool activation and execution guards enforce attachment.

## Credentials and installation

Uses `composio.apiKey` from the generated `secrets/personal.json` relative to the
Pi agent directory. This must be a `ck_` consumer key from For You → AI Clients.
The key is sent as `x-consumer-api-key` to `https://connect.composio.dev/mcp` and is
never stored in session messages or committed configuration.

Dependencies and versions are in `agent/package.json` and `agent/bun.lock`;
`scripts/install.nu` installs them on other machines. Pi supplies its own runtime
to the experimental provider through its extension loader. The provider declares
an optional Pi peer below 1.0, but its `defineTool` interface works with Pi 1.0.

## Apps and tool permissions

Edit `agent/composio.json`, then disconnect/reconnect to load changes. Initially
only Gmail is allowed, including reading, drafting, sending, and label actions.
An omitted `enable` list permits all actions in that toolkit; an empty `enable`
list permits none. `disable` takes precedence.

For example, to allow selected Gmail actions and add Calendar and GitHub:

```json
{
  "toolkits": ["gmail", "googlecalendar", "github"],
  "tools": {
    "gmail": {
      "enable": ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"]
    }
  }
}
```

Use discovered exact tool slugs when adding action rules. Connect additional apps
in the Composio dashboard before using them. Apps with no action rule allow all
their actions.

These are local extension checks on every execution and schema lookup. They do
not narrow the consumer key's server-side permissions or change OAuth scopes.
Remote Bash/workbench, raw proxy, and arbitrary meta-tool execution are excluded.

## Tools

- `composio_search_tools`: search and retrieve relevant app tool schemas.
- `composio_execute_tool`: execute one exact app tool. Missing schemas can be
  fetched by executing `COMPOSIO_GET_TOOL_SCHEMAS` with `tool_slugs`.
- `composio_manage_connections`: list accounts for allowed apps. Explicit
  `reinitiate_all: true` starts OAuth for those apps.

The adapter preserves Composio's workflow session IDs, account selectors, tool
arguments, and Pi cancellation signals. It parses each MCP content block
separately because the service can append prose after its JSON payload.
