package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/urfave/cli/v2"

	"github.com/drew-council/sheer-gh/internal/config"
	ghclient "github.com/drew-council/sheer-gh/internal/gh"
)

type ctxKey struct{}

var errNotContained = errors.New("not contained")

func rt(c *cli.Context) *Runtime { return c.Context.Value(ctxKey{}).(*Runtime) }
func needArg(c *cli.Context, n int, name string) error {
	if c.NArg() <= n {
		return cli.Exit(name+" is required", 2)
	}
	return nil
}

func trailingBool(c *cli.Context, name string) bool {
	if c.Bool(name) {
		return true
	}
	needle := "--" + name
	for _, arg := range c.Args().Slice() {
		if arg == needle {
			return true
		}
	}
	return false
}

func trailingValue(c *cli.Context, name string) string {
	if c.IsSet(name) {
		return c.String(name)
	}
	needle := "--" + name
	args := c.Args().Slice()
	for i, arg := range args {
		if arg == needle && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, needle+"=") {
			return strings.TrimPrefix(arg, needle+"=")
		}
	}
	return c.String(name)
}

func New() *cli.App {
	app := &cli.App{
		Name:      "sheer-gh",
		Usage:     "GitHub operations for sheerhealth/sheer",
		Writer:    os.Stdout,
		ErrWriter: os.Stderr,
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "repo"},
			&cli.StringFlag{Name: "cwd"},
			&cli.BoolFlag{Name: "json"},
			&cli.BoolFlag{Name: "dry-run"},
		},
		Before: func(c *cli.Context) error {
			cfg, err := config.From(
				c.String("repo"),
				c.String("cwd"),
				c.Bool("json"),
				c.Bool("dry-run"),
			)
			if err != nil {
				return cli.Exit(err.Error(), 2)
			}
			token, err := ghclient.Token(c.Context, nil)
			if err != nil {
				return err
			}
			c.Context = context.WithValue(c.Context, ctxKey{}, runtime(cfg, token))
			return nil
		},
		Commands: []*cli.Command{
			ciCommand(),
			prCommand(),
			issueCommand(),
			sprintCommand(),
			discussionCommand(),
			releaseCommand(),
			wikiCommand(),
		},
	}
	return app
}

func Run(args []string, stdout, stderr io.Writer) int {
	app := New()
	app.Writer = stdout
	app.ErrWriter = stderr
	err := ghclient.Hint(app.Run(args))
	if err == nil {
		return 0
	}
	if errors.Is(err, errNotContained) {
		return 1
	}
	if ec, ok := err.(cli.ExitCoder); ok {
		fmt.Fprintf(stderr, "error: %s\n", err)
		return ec.ExitCode()
	}
	fmt.Fprintf(stderr, "error: %s\n", err)
	return 1
}
