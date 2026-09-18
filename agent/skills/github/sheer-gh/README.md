# sheer-gh

A self-contained Go CLI for the `sheerhealth/sheer` GitHub workflow. It uses `go-github` and GraphQL; `gh` is invoked only once to read the token. Wiki commands additionally use `git`, and attachment downloads from Google Cloud Storage use `gcloud`.

## Run

```sh
bin/sheer-gh --help
# From any directory:
~/.pi/agent/skills/github/sheer-gh/bin/sheer-gh ci latest ci
```

## Develop

```sh
go test ./...
go vet ./...
golangci-lint run
```

`internal/app` defines the urfave CLI and command handlers. `internal/convo` renders an issue, PR, or discussion with its comments as markdown and downloads attachments. Pure parsing and policy live in the other `internal` packages. Add a command by implementing a `*cli.Command` and registering it in `internal/app/app.go`. Keep GitHub writes dry-run aware and use narrow helpers or interfaces for testability.
