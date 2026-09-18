package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/go-github/v66/github"
	"github.com/urfave/cli/v2"

	"github.com/drew-council/sheer-gh/internal/body"
	"github.com/drew-council/sheer-gh/internal/convo"
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
			{
				Name: "show",
				Flags: append(
					showFlags(),
					&cli.BoolFlag{Name: "all", Usage: "include resolved threads"},
				),
				Action: prShow,
			},
			{Name: "recent", Flags: []cli.Flag{&cli.StringFlag{Name: "author"}}, Action: prRecent},
			{
				Name: "threads",
				Subcommands: []*cli.Command{
					{
						Name:   "list",
						Flags:  append(showFlags(), &cli.BoolFlag{Name: "all"}),
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

const threadsQuery = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine comments(first:100){nodes{` + postFields + `}}}}}}}`

// threads returns the review threads of a PR, each with its comments nested.
func threads(ctx context.Context, r *Runtime, n int, all bool) ([]convo.Post, error) {
	var out []convo.Post
	var cursor any
	for {
		var data struct {
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
							Comments               struct{ Nodes []post }
						}
					}
				}
			}
		}
		vars := map[string]any{
			"owner":  r.Config.Owner,
			"repo":   r.Config.Repo,
			"number": n,
			"cursor": cursor,
		}
		if err := r.GH.GraphQL(ctx, threadsQuery, vars, &data); err != nil {
			return nil, err
		}
		page := data.Repository.PullRequest.ReviewThreads
		for _, t := range page.Nodes {
			if t.IsResolved && !all {
				continue
			}
			line := t.OriginalLine
			if t.Line != nil {
				line = t.Line
			}
			p := convo.Post{
				Kind: "thread",
				ID:   t.ID,
				Note: fmt.Sprintf("%s:%d", t.Path, value(line)),
			}
			if t.IsResolved {
				p.Note += " resolved"
			}
			if t.IsOutdated {
				p.Note += " outdated"
			}
			for _, comment := range t.Comments.Nodes {
				p.Posts = append(p.Posts, comment.convo("comment"))
			}
			if len(p.Posts) > 0 {
				p.Time = p.Posts[0].Time
			}
			out = append(out, p)
		}
		if !page.PageInfo.HasNextPage {
			return out, nil
		}
		cursor = page.PageInfo.EndCursor
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
	posts, err := threads(c.Context, r, n, trailingBool(c, "all"))
	if err != nil {
		return err
	}
	return r.show(c, &convo.Doc{Slug: fmt.Sprintf("pr-%d-threads", n), Posts: posts})
}

func prShow(c *cli.Context) error {
	if err := needArg(c, 0, "pr"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	var data struct {
		Repository struct {
			PullRequest *struct {
				Number                             int
				Title, State, URL, Body, BodyHTML  string
				BaseRefName, HeadRefName           string
				ReviewDecision                     string
				IsDraft                            bool
				Additions, Deletions, ChangedFiles int
				Author                             struct{ Login string }
				Labels                             struct{ Nodes []struct{ Name string } }
				ClosingIssuesReferences            struct{ Nodes []struct{ Number int } }
				Comments                           page
				Reviews                            struct{ Nodes []post }
			}
		}
	}
	if err := r.GH.GraphQL(
		c.Context,
		`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title state isDraft url body bodyHTML baseRefName headRefName additions deletions changedFiles reviewDecision author{login} labels(first:20){nodes{name}} closingIssuesReferences(first:10){nodes{number}} comments(first:100){pageInfo{hasNextPage endCursor} nodes{`+postFields+`}} reviews(first:100){nodes{`+postFields+` state}}}}}`,
		map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo, "number": n},
		&data,
	); err != nil {
		return err
	}
	v := data.Repository.PullRequest
	if v == nil {
		return fmt.Errorf("pull request #%d not found", n)
	}
	comments, err := moreComments(c.Context, r, n, v.Comments)
	if err != nil {
		return err
	}
	posts, err := threads(c.Context, r, n, trailingBool(c, "all"))
	if err != nil {
		return err
	}
	state := v.State
	if v.IsDraft {
		state += " draft"
	}
	var ls, closes []string
	for _, l := range v.Labels.Nodes {
		ls = append(ls, l.Name)
	}
	for _, i := range v.ClosingIssuesReferences.Nodes {
		closes = append(closes, fmt.Sprintf("#%d", i.Number))
	}
	doc := &convo.Doc{
		Slug:  fmt.Sprintf("pr-%d", n),
		Title: fmt.Sprintf("#%d %s", v.Number, v.Title),
		Header: []string{
			"state: " + state,
			"author: " + v.Author.Login,
			fmt.Sprintf("branch: %s <- %s", v.BaseRefName, v.HeadRefName),
			fmt.Sprintf("diff: +%d -%d in %d files", v.Additions, v.Deletions, v.ChangedFiles),
			"labels: " + join(ls),
			"closes: " + join(closes),
			"review: " + fallback(v.ReviewDecision),
			v.URL,
		},
		Body:  v.Body,
		HTML:  v.BodyHTML,
		Posts: posts,
	}
	for _, p := range comments {
		doc.Posts = append(doc.Posts, p.convo("comment"))
	}
	for _, p := range v.Reviews.Nodes {
		if strings.TrimSpace(p.Body) == "" && p.State == "COMMENTED" {
			continue // an empty review only carries its inline threads
		}
		review := p.convo("review")
		review.Note = p.State
		doc.Posts = append(doc.Posts, review)
	}
	return r.show(c, doc)
}

func value(p *int) int {
	if p == nil {
		return 0
	}
	return *p
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
