package app

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/go-github/v66/github"
	"github.com/urfave/cli/v2"
	"golang.org/x/sync/errgroup"

	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/refs"
	releaseutil "github.com/drew-council/sheer-gh/internal/releases"
)

func releaseCommand() *cli.Command {
	return &cli.Command{
		Name:  "release",
		Usage: "inspect and draft releases",
		Subcommands: []*cli.Command{
			{Name: "list", Action: releaseList},
			{Name: "show", Action: releaseShow},
			{Name: "contains", Action: releaseContains},
			{Name: "first", Action: releaseFirst},
			{
				Name:   "next-tag",
				Flags:  []cli.Flag{&cli.BoolFlag{Name: "hotfix"}},
				Action: releaseNextTag,
			},
			{
				Name:   "draft",
				Flags:  []cli.Flag{&cli.StringFlag{Name: "target"}, &cli.StringFlag{Name: "tag"}},
				Action: releaseDraft,
			},
		},
	}
}

func releaseList(c *cli.Context) error {
	r := rt(c)
	n := 10
	if c.NArg() > 0 {
		fmt.Sscan(c.Args().First(), &n)
	}
	items, _, err := r.GH.REST.Repositories.ListReleases(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		&github.ListOptions{PerPage: n},
	)
	if err != nil {
		return err
	}
	rows := make([]output.Row, 0, len(items))
	for i, v := range items {
		state := ""
		if v.GetDraft() {
			state = "draft"
		} else if v.GetPrerelease() {
			state = "pre"
		} else if i == 0 {
			state = "latest"
		}
		published := "unpublished"
		if v.PublishedAt != nil {
			published = v.PublishedAt.Format("2006-01-02T15:04")
		}
		rows = append(rows, output.R("tag", v.GetTagName(), "published", published, "state", state))
	}
	return r.rows(rows...)
}

func getRelease(c *cli.Context) (*github.RepositoryRelease, error) {
	r := rt(c)
	var v *github.RepositoryRelease
	var err error
	if c.NArg() > 0 {
		v, _, err = r.GH.REST.Repositories.GetReleaseByTag(
			c.Context,
			r.Config.Owner,
			r.Config.Repo,
			c.Args().First(),
		)
	} else {
		v, _, err = r.GH.REST.Repositories.GetLatestRelease(
			c.Context,
			r.Config.Owner,
			r.Config.Repo,
		)
	}
	return v, err
}

func releaseShow(c *cli.Context) error {
	v, err := getRelease(c)
	if err != nil {
		return err
	}
	fmt.Fprintf(rt(c).Out, "# %s\n\n%s\n\n%s\n", v.GetName(), v.GetHTMLURL(), v.GetBody())
	return nil
}

func resolveSHA(ctx context.Context, r *Runtime, arg string) (string, error) {
	if refs.IsSHA(arg) {
		return arg, nil
	}
	n, err := refs.Number(arg)
	if err != nil {
		return "", err
	}
	pr, _, err := r.GH.REST.PullRequests.Get(ctx, r.Config.Owner, r.Config.Repo, n)
	if err != nil {
		return "", err
	}
	if !pr.GetMerged() {
		return "", fmt.Errorf("PR #%d is not merged", n)
	}
	return pr.GetMergeCommitSHA(), nil
}

func compare(ctx context.Context, r *Runtime, tag, sha string) (bool, error) {
	v, _, err := r.GH.REST.Repositories.CompareCommits(
		ctx,
		r.Config.Owner,
		r.Config.Repo,
		tag,
		sha,
		nil,
	)
	if err != nil {
		return false, err
	}
	return releaseutil.ContainsStatus(v.GetStatus()), nil
}

func releaseContains(c *cli.Context) error {
	if err := needArg(c, 0, "pr or sha"); err != nil {
		return err
	}
	r := rt(c)
	var sha, tag string
	g, ctx := errgroup.WithContext(c.Context)
	g.Go(func() error { var e error; sha, e = resolveSHA(ctx, r, c.Args().First()); return e })
	if c.NArg() > 1 {
		tag = c.Args().Get(1)
	} else {
		g.Go(func() error {
			v, _, e := r.GH.REST.Repositories.GetLatestRelease(ctx, r.Config.Owner, r.Config.Repo)
			if e == nil {
				tag = v.GetTagName()
			}
			return e
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	yes, err := compare(c.Context, r, tag, sha)
	if err != nil {
		return err
	}
	if yes {
		fmt.Fprintf(r.Out, "yes: %s is in %s\n", first(sha, 12), tag)
		return nil
	}
	fmt.Fprintf(r.Out, "no: %s is not in %s\n", first(sha, 12), tag)
	return errNotContained
}

func releaseFirst(c *cli.Context) error {
	if err := needArg(c, 0, "pr or sha"); err != nil {
		return err
	}
	r := rt(c)
	sha, err := resolveSHA(c.Context, r, c.Args().First())
	if err != nil {
		return err
	}
	items, _, err := r.GH.REST.Repositories.ListReleases(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		&github.ListOptions{PerPage: 40},
	)
	if err != nil {
		return err
	}
	type match struct {
		tag       string
		published time.Time
	}
	var matches []match
	var mu sync.Mutex
	g, ctx := errgroup.WithContext(c.Context)
	g.SetLimit(8)
	for _, v := range items {
		if v.GetDraft() {
			continue
		}
		v := v
		g.Go(func() error {
			yes, e := compare(ctx, r, v.GetTagName(), sha)
			if e != nil {
				return e
			}
			if yes {
				mu.Lock()
				matches = append(matches, match{v.GetTagName(), v.GetPublishedAt().Time})
				mu.Unlock()
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	if len(matches) == 0 {
		return cli.Exit("not in any of the last 40 releases", 1)
	}
	sort.Slice(
		matches,
		func(i, j int) bool { return matches[i].published.Before(matches[j].published) },
	)
	fmt.Fprintln(r.Out, matches[0].tag)
	return nil
}

func matchingTags(ctx context.Context, r *Runtime) ([]string, error) {
	prefix := "tags/v" + time.Now().Format("2006-01-02") + "."
	refsList, _, err := r.GH.REST.Git.ListMatchingRefs(
		ctx,
		r.Config.Owner,
		r.Config.Repo,
		&github.ReferenceListOptions{Ref: prefix},
	)
	if err != nil {
		return nil, err
	}
	tags := make([]string, 0, len(refsList))
	for _, v := range refsList {
		tags = append(tags, strings.TrimPrefix(v.GetRef(), "refs/tags/"))
	}
	return tags, nil
}

func releaseNextTag(c *cli.Context) error {
	tags, err := matchingTags(c.Context, rt(c))
	if err != nil {
		return err
	}
	fmt.Fprintln(rt(c).Out, releaseutil.Next(tags, time.Now(), c.Bool("hotfix")))
	return nil
}

func releaseDraft(c *cli.Context) error {
	r := rt(c)
	target, tag := c.String("target"), c.String("tag")
	g, ctx := errgroup.WithContext(c.Context)
	if target == "" {
		g.Go(func() error {
			v, _, e := r.GH.REST.Repositories.GetCommit(
				ctx,
				r.Config.Owner,
				r.Config.Repo,
				"main",
				nil,
			)
			if e == nil {
				target = v.GetSHA()
			}
			return e
		})
	}
	if tag == "" {
		g.Go(func() error {
			tags, e := matchingTags(ctx, r)
			if e == nil {
				tag = releaseutil.Next(tags, time.Now(), false)
			}
			return e
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	if r.dry("create draft release %s target=%s generate-notes", tag, target) {
		return nil
	}
	v, _, err := r.GH.REST.Repositories.CreateRelease(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		&github.RepositoryRelease{
			TagName:              &tag,
			TargetCommitish:      &target,
			Name:                 &tag,
			Draft:                github.Bool(true),
			GenerateReleaseNotes: github.Bool(true),
		},
	)
	if err == nil {
		fmt.Fprintln(r.Out, v.GetHTMLURL())
	}
	return err
}
