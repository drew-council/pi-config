package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/urfave/cli/v2"

	wikistore "github.com/drew-council/sheer-gh/internal/wiki"
)

func wikiCommand() *cli.Command {
	return &cli.Command{
		Name:  "wiki",
		Usage: "read the repository wiki",
		Subcommands: []*cli.Command{
			{Name: "sync", Action: wikiSync},
			{Name: "list", Action: wikiList},
			{Name: "search", Action: wikiSearch},
			{Name: "show", Action: wikiShow},
			{Name: "path", Action: wikiPath},
		},
	}
}

func store(r *Runtime) wikistore.Store {
	return wikistore.Store{
		Dir: r.Config.WikiDir,
		URL: "https://github.com/" + r.Config.Slug() + ".wiki.git",
	}
}

func syncWiki(r *Runtime, force bool) error {
	s := store(r)
	if force || s.NeedsSync(time.Now()) {
		if err := s.Sync(); err != nil {
			if _, statErr := os.Stat(s.Dir); statErr == nil {
				fmt.Fprintf(r.Err, "warning: %v; using existing clone\n", err)
				return nil
			}
			return err
		}
	}
	return nil
}
func wikiSync(c *cli.Context) error { return syncWiki(rt(c), true) }
func wikiList(c *cli.Context) error {
	r := rt(c)
	if err := syncWiki(r, false); err != nil {
		return err
	}
	files, err := store(r).Files()
	if err != nil {
		return err
	}
	for _, f := range files {
		fmt.Fprintln(r.Out, wikistore.Title(f))
	}
	return nil
}

func wikiSearch(c *cli.Context) error {
	if c.NArg() == 0 {
		return cli.Exit("search needs words", 2)
	}
	r := rt(c)
	if err := syncWiki(r, false); err != nil {
		return err
	}
	matches, err := store(r).Search(strings.Join(c.Args().Slice(), " "))
	if err != nil {
		return err
	}
	for _, m := range matches {
		fmt.Fprintf(r.Out, "== %s\n", m.Page)
		for _, line := range m.Lines {
			fmt.Fprintf(r.Out, "   %s\n", line)
		}
	}
	return nil
}

func wikiFile(c *cli.Context) (string, error) {
	if err := needArg(c, 0, "page"); err != nil {
		return "", err
	}
	r := rt(c)
	if err := syncWiki(r, false); err != nil {
		return "", err
	}
	return store(r).Resolve(c.Args().First())
}

func wikiShow(c *cli.Context) error {
	f, err := wikiFile(c)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(f)
	if err != nil {
		return err
	}
	fmt.Fprintf(
		rt(c).Out,
		"<!-- https://github.com/%s/wiki/%s -->\n%s",
		rt(c).Config.Slug(),
		strings.TrimSuffix(filepath.Base(f), ".md"),
		data,
	)
	return nil
}

func wikiPath(c *cli.Context) error {
	f, err := wikiFile(c)
	if err == nil {
		fmt.Fprintln(rt(c).Out, f)
	}
	return err
}
