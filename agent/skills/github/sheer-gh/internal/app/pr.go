package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/go-github/v66/github"
	"github.com/urfave/cli/v2"

	"github.com/drew-council/sheer-gh/internal/body"
	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/prlint"
	"github.com/drew-council/sheer-gh/internal/refs"
)

func bodyFlags() []cli.Flag {
	return []cli.Flag{
		&cli.StringFlag{Name: "body"},
		&cli.StringFlag{Name: "body-file"},
		&cli.BoolFlag{Name: "no-attribution"},
	}
}

func prCommand() *cli.Command {
	return &cli.Command{
		Name:  "pr",
		Usage: "pull request bodies, comments, and review threads",
		Subcommands: []*cli.Command{
			{Name: "template", Action: prTemplate},
			{Name: "check", Action: prCheck},
			{Name: "recent", Flags: []cli.Flag{&cli.StringFlag{Name: "author"}}, Action: prRecent},
			{
				Name: "threads",
				Subcommands: []*cli.Command{
					{
						Name:   "list",
						Flags:  []cli.Flag{&cli.BoolFlag{Name: "all"}},
						Action: threadList,
					},
					{Name: "show", Action: threadShow},
					{Name: "reply", Flags: bodyFlags(), Action: threadReply},
					{Name: "resolve", Action: threadResolve},
				},
			},
			{Name: "comment", Flags: bodyFlags(), Action: prComment},
		},
	}
}

func prTemplate(c *cli.Context) error {
	text, err := rt(c).template(c.Context, ".github/pull_request_template.md")
	if err == nil {
		_, err = fmt.Fprint(rt(c).Out, text)
	}
	return err
}

func headings(template string) []string {
	var out []string
	for _, line := range strings.Split(template, "\n") {
		if strings.HasPrefix(line, "## ") {
			out = append(out, line)
		}
	}
	return out
}

func printLint(r *Runtime, result prlint.Result) error {
	for _, v := range result.OK {
		fmt.Fprintln(r.Out, "ok  ", v)
	}
	for _, v := range result.Warnings {
		fmt.Fprintln(r.Out, "warn", v)
	}
	for _, v := range result.Failures {
		fmt.Fprintln(r.Out, "FAIL", v)
	}
	if len(result.Failures) > 0 {
		return cli.Exit("PR body check failed", 1)
	}
	return nil
}

func prCheck(c *cli.Context) error {
	if err := needArg(c, 0, "pr or file"); err != nil {
		return err
	}
	r := rt(c)
	target := c.Args().First()
	template, err := r.template(c.Context, ".github/pull_request_template.md")
	if err != nil {
		return err
	}
	path := target
	if !filepath.IsAbs(path) {
		path = filepath.Join(r.Config.CWD, path)
	}
	if data, e := os.ReadFile(path); e == nil {
		return printLint(r, prlint.Check(string(data), 0, nil, headings(template)))
	}
	n, err := refs.Number(target)
	if err != nil {
		return err
	}
	pr, _, err := r.GH.REST.PullRequests.Get(c.Context, r.Config.Owner, r.Config.Repo, n)
	if err != nil {
		return err
	}
	fmt.Fprintf(r.Out, "#%d %s (draft=%t)\n", n, pr.GetTitle(), pr.GetDraft())
	return printLint(
		r,
		prlint.Check(
			pr.GetBody(),
			pr.GetAdditions()+pr.GetDeletions(),
			labels(pr.Labels),
			headings(template),
		),
	)
}

func prRecent(c *cli.Context) error {
	r := rt(c)
	n := 3
	if c.NArg() > 0 {
		var err error
		n, err = strconv.Atoi(c.Args().First())
		if err != nil {
			return err
		}
	}
	prs, _, err := r.GH.REST.PullRequests.List(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		&github.PullRequestListOptions{
			State:       "closed",
			ListOptions: github.ListOptions{PerPage: n},
		},
	)
	if err != nil {
		return err
	}
	count := 0
	for _, pr := range prs {
		author := trailingValue(c, "author")
		if pr.GetMergedAt().IsZero() ||
			(author != "" && pr.GetUser().GetLogin() != author) {
			continue
		}
		fmt.Fprintf(
			r.Out,
			"===== #%d %s (@%s)\n%s\n\n",
			pr.GetNumber(),
			pr.GetTitle(),
			pr.GetUser().GetLogin(),
			pr.GetBody(),
		)
		count++
		if count >= n {
			break
		}
	}
	return nil
}

const threadsQuery = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine comments(first:100){nodes{databaseId author{login} createdAt body}}}}}}}`

type threadsData struct {
	Repository struct {
		PullRequest struct {
			ReviewThreads struct {
				PageInfo struct {
					HasNextPage bool
					EndCursor   string
				}
				Nodes []struct {
					ID                     string
					IsResolved, IsOutdated bool
					Path                   string
					Line, OriginalLine     *int
					Comments               struct {
						Nodes []struct {
							DatabaseID int64
							Author     struct{ Login string }
							CreatedAt  string
							Body       string
						}
					}
				}
			}
		}
	}
}

func threadList(c *cli.Context) error {
	if err := needArg(c, 0, "pr"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	cursor := ""
	for {
		var data threadsData
		vars := map[string]any{
			"owner":  r.Config.Owner,
			"repo":   r.Config.Repo,
			"number": n,
			"cursor": nil,
		}
		if cursor != "" {
			vars["cursor"] = cursor
		}
		if err := r.GH.GraphQL(c.Context, threadsQuery, vars, &data); err != nil {
			return err
		}
		page := data.Repository.PullRequest.ReviewThreads
		for _, t := range page.Nodes {
			if t.IsResolved && !trailingBool(c, "all") {
				continue
			}
			line := t.OriginalLine
			if t.Line != nil {
				line = t.Line
			}
			fmt.Fprintf(
				r.Out,
				"=== thread %s  %s:%d  resolved=%t outdated=%t\n",
				t.ID,
				t.Path,
				value(line),
				t.IsResolved,
				t.IsOutdated,
			)
			for _, comment := range t.Comments.Nodes {
				fmt.Fprintf(
					r.Out,
					"  [comment %d] @%s %s\n",
					comment.DatabaseID,
					comment.Author.Login,
					first(comment.CreatedAt, 10),
				)
				for _, line := range strings.Split(comment.Body, "\n") {
					fmt.Fprintf(r.Out, "      %s\n", line)
				}
			}
			fmt.Fprintln(r.Out)
		}
		if !page.PageInfo.HasNextPage {
			break
		}
		cursor = page.PageInfo.EndCursor
	}
	return nil
}

func value(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func first(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

func threadShow(c *cli.Context) error {
	if err := needArg(c, 0, "comment-id"); err != nil {
		return err
	}
	r := rt(c)
	id, err := strconv.ParseInt(c.Args().First(), 10, 64)
	if err != nil {
		return err
	}
	comment, _, err := r.GH.REST.PullRequests.GetComment(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		id,
	)
	if err != nil {
		return err
	}
	fmt.Fprintf(
		r.Out,
		"@%s %s:%d  in_reply_to=%d\n%s\n--- hunk\n%s\n--- body\n%s\n",
		comment.GetUser().GetLogin(),
		comment.GetPath(),
		comment.GetLine(),
		comment.GetInReplyTo(),
		comment.GetHTMLURL(),
		comment.GetDiffHunk(),
		comment.GetBody(),
	)
	return nil
}

func commentBody(c *cli.Context, r *Runtime) (string, error) {
	text, err := body.Read(
		trailingValue(c, "body"),
		trailingValue(c, "body-file"),
		r.Config.CWD,
		r.In,
	)
	if err != nil {
		return "", err
	}
	if trailingBool(c, "no-attribution") {
		return text, nil
	}
	user, _, err := r.GH.REST.Users.Get(c.Context, "")
	if err != nil {
		return "", err
	}
	return body.Attribution(text, os.Getenv("AGENT_NAME"), user.GetLogin()), nil
}

func threadReply(c *cli.Context) error {
	if err := needArg(c, 0, "comment-id"); err != nil {
		return err
	}
	r := rt(c)
	id, err := strconv.ParseInt(c.Args().First(), 10, 64)
	if err != nil {
		return err
	}
	text, err := commentBody(c, r)
	if err != nil {
		return err
	}
	if r.dry("POST repos/%s/pulls/comments/%d/replies", r.Config.Slug(), id) {
		return nil
	}
	parent, _, err := r.GH.REST.PullRequests.GetComment(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		id,
	)
	if err != nil {
		return err
	}
	parts := strings.Split(strings.TrimSuffix(parent.GetPullRequestURL(), "/"), "/")
	prNumber, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		return fmt.Errorf("parse pull request URL: %w", err)
	}
	comment, _, err := r.GH.REST.PullRequests.CreateCommentInReplyTo(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		prNumber,
		text,
		id,
	)
	if err == nil {
		fmt.Fprintln(r.Out, comment.GetHTMLURL())
	}
	return err
}

func threadResolve(c *cli.Context) error {
	if err := needArg(c, 0, "thread-id"); err != nil {
		return err
	}
	r := rt(c)
	id := c.Args().First()
	if r.dry("resolve review thread %s", id) {
		return nil
	}
	var data struct {
		ResolveReviewThread struct {
			Thread struct {
				ID         string
				IsResolved bool
			}
		}
	}
	err := r.GH.GraphQL(
		c.Context,
		`mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}`,
		map[string]any{"t": id},
		&data,
	)
	if err == nil {
		fmt.Fprintf(
			r.Out,
			"%s resolved=%t\n",
			data.ResolveReviewThread.Thread.ID,
			data.ResolveReviewThread.Thread.IsResolved,
		)
	}
	return err
}

func prComment(c *cli.Context) error {
	if err := needArg(c, 0, "pr"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	text, err := commentBody(c, r)
	if err != nil {
		return err
	}
	if r.dry("POST repos/%s/issues/%d/comments", r.Config.Slug(), n) {
		return nil
	}
	comment, _, err := r.GH.REST.Issues.CreateComment(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		n,
		&github.IssueComment{Body: github.String(text)},
	)
	if err == nil {
		fmt.Fprintln(r.Out, comment.GetHTMLURL())
	}
	return err
}

var _ = output.Row{}
