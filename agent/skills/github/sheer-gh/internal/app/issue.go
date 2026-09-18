package app

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/google/go-github/v66/github"
	"github.com/urfave/cli/v2"
	"golang.org/x/sync/errgroup"

	"github.com/drew-council/sheer-gh/internal/body"
	"github.com/drew-council/sheer-gh/internal/convo"
	"github.com/drew-council/sheer-gh/internal/forms"
	ghclient "github.com/drew-council/sheer-gh/internal/gh"
	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/refs"
)

func issueCommand() *cli.Command {
	return &cli.Command{
		Name:  "issue",
		Usage: "issue forms, types, parents, and details",
		Subcommands: []*cli.Command{
			{Name: "templates", Action: issueTemplates},
			{Name: "template", Action: issueTemplate},
			{
				Name: "new",
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "template", Required: true},
					&cli.StringFlag{Name: "title", Required: true},
					&cli.StringFlag{Name: "body"},
					&cli.StringFlag{Name: "body-file"},
					&cli.StringFlag{Name: "type"},
					&cli.StringFlag{Name: "assignee"},
					&cli.StringSliceFlag{Name: "label"},
					&cli.StringFlag{Name: "parent"},
					&cli.StringFlag{Name: "sprint"},
				},
				Action: issueNew,
			},
			{Name: "type", Action: issueType},
			{Name: "parent", Action: issueParent},
			{Name: "subs", Action: issueSubs},
			{Name: "show", Flags: showFlags(), Action: issueShow},
		},
	}
}

func formFiles(c *cli.Context) (map[string]forms.Form, error) {
	r := rt(c)
	_, files, _, err := r.GH.REST.Repositories.GetContents(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		".github/ISSUE_TEMPLATE",
		nil,
	)
	if err != nil {
		return nil, err
	}
	out := map[string]forms.Form{}
	var mu sync.Mutex
	g, ctx := errgroup.WithContext(c.Context)
	for _, entry := range files {
		if filepath.Ext(entry.GetName()) != ".yml" {
			continue
		}
		entry := entry
		g.Go(func() error {
			text, err := r.template(ctx, entry.GetPath())
			if err != nil {
				return err
			}
			form, err := forms.Parse([]byte(text))
			if err != nil {
				return err
			}
			mu.Lock()
			out[strings.TrimSuffix(entry.GetName(), ".yml")] = form
			mu.Unlock()
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

func issueTemplates(c *cli.Context) error {
	all, err := formFiles(c)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(all))
	for n := range all {
		names = append(names, n)
	}
	sort.Strings(names)
	rows := make([]output.Row, 0, len(names))
	for _, n := range names {
		f := all[n]
		rows = append(
			rows,
			output.R("form", n, "type", f.Type, "labels", strings.Join(f.Labels, ",")),
		)
	}
	return rt(c).rows(rows...)
}

func getForm(c *cli.Context, name string) (forms.Form, error) {
	name = strings.TrimSuffix(name, ".yml")
	text, err := rt(c).template(c.Context, ".github/ISSUE_TEMPLATE/"+name+".yml")
	if err != nil {
		return forms.Form{}, err
	}
	return forms.Parse([]byte(text))
}

func issueTemplate(c *cli.Context) error {
	if err := needArg(c, 0, "form"); err != nil {
		return err
	}
	f, err := getForm(c, c.Args().First())
	if err == nil {
		_, err = fmt.Fprint(rt(c).Out, f.Template())
	}
	return err
}

func issueIDs(ctx context.Context, r *Runtime, n int) (string, error) {
	var data struct {
		Repository struct{ Issue struct{ ID string } }
	}
	err := r.GH.GraphQL(
		ctx,
		`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id}}}`,
		map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo, "number": n},
		&data,
	)
	return data.Repository.Issue.ID, err
}

func typeID(ctx context.Context, r *Runtime, name string) (string, error) {
	var data struct {
		Organization struct {
			IssueTypes struct{ Nodes []struct{ ID, Name string } }
		}
	}
	if err := r.GH.GraphQL(
		ctx,
		`query($org:String!){organization(login:$org){issueTypes(first:20){nodes{id name}}}}`,
		map[string]any{"org": r.Config.Owner},
		&data,
	); err != nil {
		return "", err
	}
	for _, t := range data.Organization.IssueTypes.Nodes {
		if t.Name == name {
			return t.ID, nil
		}
	}
	return "", fmt.Errorf("no issue type %q", name)
}

func setType(ctx context.Context, r *Runtime, n int, name string) error {
	iid, err := issueIDs(ctx, r, n)
	if err != nil {
		return err
	}
	tid, err := typeID(ctx, r, name)
	if err != nil {
		return err
	}
	if r.dry("set type of #%d to %s", n, name) {
		return nil
	}
	var data any
	return r.GH.GraphQL(
		ctx,
		`mutation($i:ID!,$t:ID!){updateIssueIssueType(input:{issueId:$i,issueTypeId:$t}){issue{number}}}`,
		map[string]any{"i": iid, "t": tid},
		&data,
	)
}

func issueType(c *cli.Context) error {
	if err := needArg(c, 1, "issue and type"); err != nil {
		return err
	}
	n, err := refs.Number(c.Args().Get(0))
	if err != nil {
		return err
	}
	if rt(c).Config.DryRun {
		return setType(c.Context, rt(c), n, c.Args().Get(1))
	}
	if err = setType(c.Context, rt(c), n, c.Args().Get(1)); err == nil {
		fmt.Fprintf(rt(c).Out, "#%d type=%s\n", n, c.Args().Get(1))
	}
	return err
}

func issueParent(c *cli.Context) error {
	if err := needArg(c, 1, "issue and parent"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().Get(0))
	if err != nil {
		return err
	}
	p, err := refs.Number(c.Args().Get(1))
	if err != nil {
		return err
	}
	issue, _, err := r.GH.REST.Issues.Get(c.Context, r.Config.Owner, r.Config.Repo, n)
	if err != nil {
		return err
	}
	if r.dry(
		"POST repos/%s/issues/%d/sub_issues sub_issue_id=%d",
		r.Config.Slug(),
		p,
		issue.GetID(),
	) {
		return nil
	}
	var result github.Issue
	if err = r.post(
		c.Context,
		fmt.Sprintf("repos/%s/issues/%d/sub_issues", r.Config.Slug(), p),
		map[string]any{"sub_issue_id": issue.GetID()},
		&result,
	); err == nil {
		fmt.Fprintf(
			r.Out,
			"#%d is now a sub-issue of #%d %s\n",
			n,
			result.GetNumber(),
			result.GetTitle(),
		)
	}
	return err
}

func issueSubs(c *cli.Context) error {
	if err := needArg(c, 0, "issue"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	var issues []*github.Issue
	if err = r.get(
		c.Context,
		fmt.Sprintf("repos/%s/issues/%d/sub_issues?per_page=100", r.Config.Slug(), n),
		&issues,
	); err != nil {
		return err
	}
	rows := make([]output.Row, 0, len(issues))
	for _, i := range issues {
		users := []string{}
		for _, u := range i.Assignees {
			users = append(users, u.GetLogin())
		}
		rows = append(
			rows,
			output.R(
				"number",
				i.GetNumber(),
				"state",
				i.GetState(),
				"assignees",
				join(users),
				"title",
				i.GetTitle(),
			),
		)
	}
	return r.rows(rows...)
}

func issueShow(c *cli.Context) error {
	if err := needArg(c, 0, "issue"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	var issue struct {
		Repository struct {
			Issue *struct {
				Number                            int
				Title, State, URL, Body, BodyHTML string
				IssueType                         *struct{ Name string }
				Parent                            *struct {
					Number int
					Title  string
				}
				Assignees        struct{ Nodes []struct{ Login string } }
				Labels           struct{ Nodes []struct{ Name string } }
				SubIssuesSummary struct{ Total, Completed int }
				Comments         page
			}
		}
	}
	var item boardItem
	var boardErr error
	g, ctx := errgroup.WithContext(c.Context)
	g.Go(func() error {
		return r.GH.GraphQL(
			ctx,
			`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){number title state url body bodyHTML issueType{name} parent{number title} assignees(first:10){nodes{login}} labels(first:20){nodes{name}} subIssuesSummary{total completed} comments(first:100){pageInfo{hasNextPage endCursor} nodes{`+postFields+`}}}}}`,
			map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo, "number": n},
			&issue,
		)
	})
	// Board fields need the read:project scope; show the issue without them if that fails.
	g.Go(func() error { item, boardErr = getBoardItem(ctx, r, n); return nil })
	if err := g.Wait(); err != nil {
		return err
	}
	v := issue.Repository.Issue
	if v == nil {
		return fmt.Errorf("issue #%d not found", n)
	}
	comments, err := moreComments(c.Context, r, n, v.Comments)
	if err != nil {
		return err
	}
	typ, parent := "-", "-"
	if v.IssueType != nil {
		typ = v.IssueType.Name
	}
	if v.Parent != nil {
		parent = fmt.Sprintf("#%d %s", v.Parent.Number, v.Parent.Title)
	}
	var us, ls []string
	for _, u := range v.Assignees.Nodes {
		us = append(us, u.Login)
	}
	for _, l := range v.Labels.Nodes {
		ls = append(ls, l.Name)
	}
	doc := &convo.Doc{
		Slug:  fmt.Sprintf("issue-%d", n),
		Title: fmt.Sprintf("#%d %s", v.Number, v.Title),
		Header: []string{
			"state: " + v.State,
			"type: " + typ,
			"parent: " + parent,
			"assignees: " + join(us),
			"labels: " + join(ls),
			fmt.Sprintf(
				"sub-issues: %d/%d",
				v.SubIssuesSummary.Completed,
				v.SubIssuesSummary.Total,
			),
		},
		Body: v.Body,
		HTML: v.BodyHTML,
	}
	if boardErr != nil {
		doc.Header = append(doc.Header, "board: unavailable: "+ghclient.Hint(boardErr).Error())
	} else {
		doc.Header = append(doc.Header, boardLines(item)...)
	}
	doc.Header = append(doc.Header, v.URL)
	for _, p := range comments {
		doc.Posts = append(doc.Posts, p.convo("comment"))
	}
	return r.show(c, doc)
}

func issueNew(c *cli.Context) error {
	r := rt(c)
	f, err := getForm(c, c.String("template"))
	if err != nil {
		return err
	}
	typ := c.String("type")
	if typ == "" {
		typ = f.Type
	}
	text, err := body.Read(c.String("body"), c.String("body-file"), r.Config.CWD, r.In)
	if err != nil {
		return err
	}
	labels := append(c.StringSlice("label"), f.Labels...)
	if _, err := typeID(c.Context, r, typ); err != nil {
		return err
	}
	if r.dry(
		"POST repos/%s/issues title=%q labels=%s; then type=%s parent=%s sprint=%s",
		r.Config.Slug(),
		c.String("title"),
		strings.Join(labels, ","),
		typ,
		c.String("parent"),
		c.String("sprint"),
	) {
		return nil
	}
	req := &github.IssueRequest{
		Title:  github.String(c.String("title")),
		Body:   github.String(text),
		Labels: &labels,
	}
	if a := c.String("assignee"); a != "" {
		if a == "@me" {
			user, _, err := r.GH.REST.Users.Get(c.Context, "")
			if err != nil {
				return err
			}
			a = user.GetLogin()
		}
		req.Assignee = &a
	}
	created, _, err := r.GH.REST.Issues.Create(c.Context, r.Config.Owner, r.Config.Repo, req)
	if err != nil {
		return err
	}
	fmt.Fprintln(r.Out, created.GetHTMLURL())
	g, ctx := errgroup.WithContext(c.Context)
	g.Go(func() error { return setType(ctx, r, created.GetNumber(), typ) })
	if p := c.String("parent"); p != "" {
		g.Go(func() error { return setParentNumber(ctx, r, created.GetNumber(), p) })
	}
	if s := c.String("sprint"); s != "" {
		g.Go(func() error { return setSprint(ctx, r, created.GetNumber(), s) })
	}
	return g.Wait()
}

func setParentNumber(ctx context.Context, r *Runtime, n int, parent string) error {
	p, err := refs.Number(parent)
	if err != nil {
		return err
	}
	issue, _, err := r.GH.REST.Issues.Get(ctx, r.Config.Owner, r.Config.Repo, n)
	if err != nil {
		return err
	}
	return r.post(
		ctx,
		fmt.Sprintf("repos/%s/issues/%d/sub_issues", r.Config.Slug(), p),
		map[string]any{"sub_issue_id": issue.GetID()},
		nil,
	)
}
