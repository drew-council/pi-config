package app

import (
	"fmt"
	"strings"

	"github.com/urfave/cli/v2"

	"github.com/drew-council/sheer-gh/internal/body"
	"github.com/drew-council/sheer-gh/internal/convo"
	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/refs"
)

type categories struct {
	Repository struct {
		ID                   string
		DiscussionCategories struct {
			Nodes []struct{ ID, Name, Slug string }
		}
	}
}

func getCategories(c *cli.Context) (categories, error) {
	var d categories
	r := rt(c)
	err := r.GH.GraphQL(
		c.Context,
		`query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id discussionCategories(first:30){nodes{id name slug}}}}`,
		map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo},
		&d,
	)
	return d, err
}

func categoryID(d categories, name string) (string, error) {
	for _, v := range d.Repository.DiscussionCategories.Nodes {
		if v.Name == name || v.Slug == name {
			return v.ID, nil
		}
	}
	return "", fmt.Errorf("no category %q", name)
}

func discussionCommand() *cli.Command {
	return &cli.Command{
		Name:  "discussion",
		Usage: "GitHub Discussions",
		Subcommands: []*cli.Command{
			{Name: "categories", Action: discussionCategories},
			{
				Name: "list",
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "category"},
					&cli.IntFlag{Name: "limit", Value: 30},
				},
				Action: discussionList,
			},
			{
				Name:   "search",
				Flags:  []cli.Flag{&cli.StringFlag{Name: "category"}},
				Action: discussionSearch,
			},
			{Name: "show", Flags: showFlags(), Action: discussionShow},
			{
				Name: "new",
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "category", Required: true},
					&cli.StringFlag{Name: "title", Required: true},
					&cli.StringFlag{Name: "body"},
					&cli.StringFlag{Name: "body-file"},
				},
				Action: discussionNew,
			},
		},
	}
}

func discussionCategories(c *cli.Context) error {
	d, err := getCategories(c)
	if err != nil {
		return err
	}
	rows := make([]output.Row, 0, len(d.Repository.DiscussionCategories.Nodes))
	for _, v := range d.Repository.DiscussionCategories.Nodes {
		rows = append(rows, output.R("name", v.Name, "slug", v.Slug, "id", v.ID))
	}
	return rt(c).rows(rows...)
}

func discussionList(c *cli.Context) error {
	r := rt(c)
	var cid any
	if cat := c.String("category"); cat != "" {
		d, err := getCategories(c)
		if err != nil {
			return err
		}
		id, err := categoryID(d, cat)
		if err != nil {
			return err
		}
		cid = id
	}
	var d struct {
		Repository struct {
			Discussions struct {
				Nodes []struct {
					Number           int
					Title, CreatedAt string
					Author           struct{ Login string }
					Category         struct{ Name string }
					Comments         struct{ TotalCount int }
				}
			}
		}
	}
	err := r.GH.GraphQL(
		c.Context,
		`query($owner:String!,$repo:String!,$n:Int!,$cid:ID){repository(owner:$owner,name:$repo){discussions(first:$n,categoryId:$cid,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title createdAt author{login} category{name} comments{totalCount}}}}}`,
		map[string]any{
			"owner": r.Config.Owner,
			"repo":  r.Config.Repo,
			"n":     c.Int("limit"),
			"cid":   cid,
		},
		&d,
	)
	if err != nil {
		return err
	}
	var rows []output.Row
	for _, v := range d.Repository.Discussions.Nodes {
		rows = append(
			rows,
			output.R(
				"number",
				v.Number,
				"date",
				first(v.CreatedAt, 10),
				"category",
				v.Category.Name,
				"author",
				v.Author.Login,
				"title",
				v.Title,
				"comments",
				v.Comments.TotalCount,
			),
		)
	}
	return r.rows(rows...)
}

func discussionSearch(c *cli.Context) error {
	if c.NArg() == 0 {
		return cli.Exit("search needs words", 2)
	}
	r := rt(c)
	args := c.Args().Slice()
	words := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "--category" {
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--category=") {
			continue
		}
		words = append(words, args[i])
	}
	q := "repo:" + r.Config.Slug() + " " + strings.Join(words, " ")
	if cat := trailingValue(c, "category"); cat != "" {
		q += ` category:"` + cat + `"`
	}
	var d struct {
		Search struct {
			DiscussionCount int
			Nodes           []struct {
				Number           int
				Title, CreatedAt string
				Author           struct{ Login string }
				Category         struct{ Name string }
			}
		}
	}
	if err := r.GH.GraphQL(
		c.Context,
		`query($q:String!){search(query:$q,type:DISCUSSION,first:30){discussionCount nodes{... on Discussion{number title createdAt author{login} category{name}}}}}`,
		map[string]any{"q": q},
		&d,
	); err != nil {
		return err
	}
	fmt.Fprintf(r.Out, "%d results\n", d.Search.DiscussionCount)
	for _, v := range d.Search.Nodes {
		fmt.Fprintf(
			r.Out,
			"#%d\t%s\t[%s]\t@%s\t%s\n",
			v.Number,
			first(v.CreatedAt, 10),
			v.Category.Name,
			v.Author.Login,
			v.Title,
		)
	}
	return nil
}

func discussionShow(c *cli.Context) error {
	if err := needArg(c, 0, "number"); err != nil {
		return err
	}
	r := rt(c)
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	var d struct {
		Repository struct {
			Discussion *struct {
				Title, URL, CreatedAt, Body, BodyHTML string
				Author                                struct{ Login string }
				Category                              struct{ Name string }
				Comments                              struct{ Nodes []post }
			}
		}
	}
	if err = r.GH.GraphQL(
		c.Context,
		`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){title url createdAt author{login} category{name} body bodyHTML comments(first:100){nodes{`+postFields+` replies(first:100){nodes{`+postFields+`}}}}}}}`,
		map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo, "number": n},
		&d,
	); err != nil {
		return err
	}
	v := d.Repository.Discussion
	if v == nil {
		return fmt.Errorf("discussion #%d not found", n)
	}
	doc := &convo.Doc{
		Slug:  fmt.Sprintf("discussion-%d", n),
		Title: fmt.Sprintf("#%d %s", n, v.Title),
		Header: []string{
			fmt.Sprintf("[%s] @%s %s", v.Category.Name, v.Author.Login, first(v.CreatedAt, 10)),
			v.URL,
		},
		Body: v.Body,
		HTML: v.BodyHTML,
	}
	for _, p := range v.Comments.Nodes {
		doc.Posts = append(doc.Posts, p.convo("comment"))
	}
	return r.show(c, doc)
}

func first(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

func discussionNew(c *cli.Context) error {
	r := rt(c)
	text, err := body.Read(c.String("body"), c.String("body-file"), r.Config.CWD, r.In)
	if err != nil {
		return err
	}
	d, err := getCategories(c)
	if err != nil {
		return err
	}
	cid, err := categoryID(d, c.String("category"))
	if err != nil {
		return err
	}
	if r.dry("create discussion category=%s title=%q", c.String("category"), c.String("title")) {
		return nil
	}
	var out struct {
		CreateDiscussion struct {
			Discussion struct {
				Number int
				URL    string
			}
		}
	}
	err = r.GH.GraphQL(
		c.Context,
		`mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{number url}}}`,
		map[string]any{"r": d.Repository.ID, "c": cid, "t": c.String("title"), "b": text},
		&out,
	)
	if err == nil {
		fmt.Fprintf(
			r.Out,
			"#%d %s\n",
			out.CreateDiscussion.Discussion.Number,
			out.CreateDiscussion.Discussion.URL,
		)
	}
	return err
}
