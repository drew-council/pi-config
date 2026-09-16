package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/urfave/cli/v2"
	"golang.org/x/sync/errgroup"

	"github.com/drew-council/sheer-gh/internal/iterations"
	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/refs"
)

type projectData struct {
	Organization struct {
		ProjectV2 struct {
			ID, Title string
			Field     struct {
				ID            string
				Configuration struct {
					Iterations, CompletedIterations []struct {
						ID, Title, StartDate string
						Duration             int
					}
				}
			}
		}
	}
}

func project(ctx context.Context, r *Runtime) (projectData, []iterations.Iteration, error) {
	var d projectData
	err := r.GH.GraphQL(
		ctx,
		`query($org:String!,$number:Int!,$field:String!){organization(login:$org){projectV2(number:$number){id title field(name:$field){... on ProjectV2IterationField{id configuration{iterations{id title startDate duration} completedIterations{id title startDate duration}}}}}}}`,
		map[string]any{"org": r.Config.Owner, "number": r.Config.Project, "field": "Sprint"},
		&d,
	)
	if err != nil {
		return d, nil, err
	}
	var all []iterations.Iteration
	for _, v := range d.Organization.ProjectV2.Field.Configuration.CompletedIterations {
		all = append(
			all,
			iterations.Iteration{
				ID:        v.ID,
				Title:     v.Title,
				StartDate: v.StartDate,
				Duration:  v.Duration,
				Completed: true,
			},
		)
	}
	for _, v := range d.Organization.ProjectV2.Field.Configuration.Iterations {
		all = append(
			all,
			iterations.Iteration{
				ID:        v.ID,
				Title:     v.Title,
				StartDate: v.StartDate,
				Duration:  v.Duration,
			},
		)
	}
	return d, iterations.Annotate(all, time.Now()), nil
}

type boardItem struct {
	IssueID, ItemID string
	Fields          map[string]string
}

func getBoardItem(ctx context.Context, r *Runtime, n int) (boardItem, error) {
	var d struct {
		Repository struct {
			Issue *struct {
				ID           string
				ProjectItems struct {
					Nodes []struct {
						ID          string
						Project     struct{ Number int }
						FieldValues struct {
							Nodes []struct {
								Title, Name string
								Field       *struct{ Name string }
							}
						}
					}
				}
			}
		}
	}
	err := r.GH.GraphQL(
		ctx,
		`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id projectItems(first:20,includeArchived:true){nodes{id project{number} fieldValues(first:30){nodes{... on ProjectV2ItemFieldIterationValue{field{... on ProjectV2IterationField{name}} title} ... on ProjectV2ItemFieldSingleSelectValue{field{... on ProjectV2SingleSelectField{name}} name}}}}}}}}`,
		map[string]any{"owner": r.Config.Owner, "repo": r.Config.Repo, "number": n},
		&d,
	)
	if err != nil {
		return boardItem{}, err
	}
	if d.Repository.Issue == nil {
		return boardItem{}, fmt.Errorf("issue #%d not found", n)
	}
	out := boardItem{IssueID: d.Repository.Issue.ID, Fields: map[string]string{}}
	for _, v := range d.Repository.Issue.ProjectItems.Nodes {
		if v.Project.Number != r.Config.Project {
			continue
		}
		out.ItemID = v.ID
		for _, f := range v.FieldValues.Nodes {
			if f.Field != nil {
				value := f.Title
				if value == "" {
					value = f.Name
				}
				out.Fields[f.Field.Name] = value
			}
		}
	}
	return out, nil
}

func ensureBoard(
	ctx context.Context,
	r *Runtime,
	n int,
	item boardItem,
	projectID string,
) (string, error) {
	if item.ItemID != "" {
		return item.ItemID, nil
	}
	if r.Config.DryRun {
		return "DRY_ITEM", nil
	}
	var d struct {
		AddProjectV2ItemByID struct{ Item struct{ ID string } }
	}
	err := r.GH.GraphQL(
		ctx,
		`mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`,
		map[string]any{"p": projectID, "c": item.IssueID},
		&d,
	)
	if err == nil {
		fmt.Fprintf(r.Err, "added #%d to the board\n", n)
	}
	return d.AddProjectV2ItemByID.Item.ID, err
}

func sprintCommand() *cli.Command {
	return &cli.Command{
		Name:  "sprint",
		Usage: "project sprint and field operations",
		Subcommands: []*cli.Command{
			{Name: "list", Action: sprintList},
			{Name: "current", Action: sprintCurrent},
			{Name: "show", Action: sprintShow},
			{Name: "set", Action: sprintSet},
			{Name: "status", Action: sprintStatus},
			{Name: "field", Action: sprintField},
			{
				Name:   "issues",
				Flags:  []cli.Flag{&cli.BoolFlag{Name: "mine"}, &cli.StringFlag{Name: "status"}},
				Action: sprintIssues,
			},
		},
	}
}

func sprintList(c *cli.Context) error {
	_, its, err := project(c.Context, rt(c))
	if err != nil {
		return err
	}
	rows := make([]output.Row, 0, len(its))
	for _, it := range its {
		mark := " "
		if it.State == "current" {
			mark = "*"
		}
		rows = append(
			rows,
			output.R(
				"current",
				mark,
				"id",
				it.ID,
				"title",
				it.Title,
				"start",
				it.StartDate,
				"duration",
				fmt.Sprintf("%dd", it.Duration),
				"state",
				it.State,
			),
		)
	}
	return rt(c).rows(rows...)
}

func sprintCurrent(c *cli.Context) error {
	_, its, err := project(c.Context, rt(c))
	if err != nil {
		return err
	}
	it, err := iterations.Resolve(its, "current")
	if err != nil {
		return err
	}
	return rt(c).rows(output.R("title", it.Title, "id", it.ID, "start", "starts "+it.StartDate))
}

func printBoardItem(r *Runtime, item boardItem, prefix string) {
	if item.ItemID == "" {
		fmt.Fprintf(r.Out, "%sis not on the board\n", prefix)
		return
	}
	fmt.Fprintf(r.Out, "%sitem=%s\n", prefix, item.ItemID)
	for k, v := range item.Fields {
		fmt.Fprintf(r.Out, "%s%s: %s\n", prefix, k, v)
	}
}

func sprintShow(c *cli.Context) error {
	if err := needArg(c, 0, "issue"); err != nil {
		return err
	}
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	item, err := getBoardItem(c.Context, rt(c), n)
	if err == nil {
		fmt.Fprintf(rt(c).Out, "#%d  ", n)
		printBoardItem(rt(c), item, "")
	}
	return err
}

func setSprint(ctx context.Context, r *Runtime, n int, which string) error {
	var pd projectData
	var its []iterations.Iteration
	var item boardItem
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { var e error; pd, its, e = project(gctx, r); return e })
	g.Go(func() error { var e error; item, e = getBoardItem(gctx, r, n); return e })
	if err := g.Wait(); err != nil {
		return err
	}
	it, err := iterations.Resolve(its, which)
	if err != nil {
		return err
	}
	id, err := ensureBoard(ctx, r, n, item, pd.Organization.ProjectV2.ID)
	if err != nil {
		return err
	}
	if r.dry("update project item %s Sprint=%s", id, it.Title) {
		return nil
	}
	return r.GH.GraphQL(
		ctx,
		`mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{iterationId:$v}}){projectV2Item{id}}}`,
		map[string]any{
			"p": pd.Organization.ProjectV2.ID,
			"i": id,
			"f": pd.Organization.ProjectV2.Field.ID,
			"v": it.ID,
		},
		nil,
	)
}

func sprintSet(c *cli.Context) error {
	if err := needArg(c, 0, "issue"); err != nil {
		return err
	}
	n, err := refs.Number(c.Args().First())
	if err != nil {
		return err
	}
	which := c.Args().Get(1)
	if which == "" {
		which = "current"
	}
	return setSprint(c.Context, rt(c), n, which)
}

func sprintStatus(c *cli.Context) error {
	if err := needArg(c, 1, "issue and status"); err != nil {
		return err
	}
	return setField(c, c.Args().Get(0), "Status", c.Args().Get(1))
}

func sprintField(c *cli.Context) error {
	if err := needArg(c, 2, "issue, field, and option"); err != nil {
		return err
	}
	return setField(c, c.Args().Get(0), c.Args().Get(1), c.Args().Get(2))
}

func setField(c *cli.Context, ref, field, option string) error {
	r := rt(c)
	n, err := refs.Number(ref)
	if err != nil {
		return err
	}
	var meta struct {
		Organization struct {
			ProjectV2 struct {
				ID     string
				Fields struct {
					Nodes []struct {
						ID, Name string
						Options  []struct{ ID, Name string }
					}
				}
			}
		}
	}
	var item boardItem
	g, ctx := errgroup.WithContext(c.Context)
	g.Go(func() error {
		return r.GH.GraphQL(
			ctx,
			`query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,
			map[string]any{"o": r.Config.Owner, "n": r.Config.Project},
			&meta,
		)
	})
	g.Go(func() error { var e error; item, e = getBoardItem(ctx, r, n); return e })
	if err := g.Wait(); err != nil {
		return err
	}
	var fid, oid string
	for _, f := range meta.Organization.ProjectV2.Fields.Nodes {
		if f.Name == field {
			fid = f.ID
			for _, o := range f.Options {
				if o.Name == option {
					oid = o.ID
				}
			}
		}
	}
	if fid == "" || oid == "" {
		return fmt.Errorf("field %q has no option %q", field, option)
	}
	id, err := ensureBoard(c.Context, r, n, item, meta.Organization.ProjectV2.ID)
	if err != nil {
		return err
	}
	if r.dry("update project item %s %s=%s", id, field, option) {
		return nil
	}
	return r.GH.GraphQL(
		c.Context,
		`mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){projectV2Item{id}}}`,
		map[string]any{"p": meta.Organization.ProjectV2.ID, "i": id, "f": fid, "v": oid},
		nil,
	)
}

func sprintIssues(c *cli.Context) error {
	r := rt(c)
	which := c.Args().First()
	if which == "" {
		which = "current"
	}
	_, its, err := project(c.Context, r)
	if err != nil {
		return err
	}
	it, err := iterations.Resolve(its, which)
	if err != nil {
		return err
	}
	login := ""
	if trailingBool(c, "mine") {
		u, _, err := r.GH.REST.Users.Get(c.Context, "")
		if err != nil {
			return err
		}
		login = u.GetLogin()
	}
	fmt.Fprintf(r.Err, "== %s\n", it.Title)
	statusFilter := trailingValue(c, "status")
	cursor := ""
	var rows []output.Row
	for {
		var d struct {
			Organization struct {
				ProjectV2 struct {
					Items struct {
						PageInfo struct {
							HasNextPage bool
							EndCursor   string
						}
						Nodes []struct {
							Content *struct {
								Number    int
								Title     string
								Assignees struct{ Nodes []struct{ Login string } }
							}
							FieldValues struct {
								Nodes []struct {
									Title, Name string
									Field       *struct{ Name string }
								}
							}
						}
					}
				}
			}
		}
		vars := map[string]any{"o": r.Config.Owner, "n": r.Config.Project, "cursor": nil}
		if cursor != "" {
			vars["cursor"] = cursor
		}
		err = r.GH.GraphQL(
			c.Context,
			`query($o:String!,$n:Int!,$cursor:String){organization(login:$o){projectV2(number:$n){items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{content{... on Issue{number title assignees(first:10){nodes{login}}}} fieldValues(first:20){nodes{... on ProjectV2ItemFieldIterationValue{field{... on ProjectV2IterationField{name}} title} ... on ProjectV2ItemFieldSingleSelectValue{field{... on ProjectV2SingleSelectField{name}} name}}}}}}}}`,
			vars,
			&d,
		)
		if err != nil {
			return err
		}
		page := d.Organization.ProjectV2.Items
		for _, v := range page.Nodes {
			if v.Content == nil {
				continue
			}
			fields := map[string]string{}
			for _, f := range v.FieldValues.Nodes {
				if f.Field != nil {
					x := f.Title
					if x == "" {
						x = f.Name
					}
					fields[f.Field.Name] = x
				}
			}
			if fields["Sprint"] != it.Title ||
				(statusFilter != "" && fields["Status"] != statusFilter) {
				continue
			}
			var users []string
			for _, u := range v.Content.Assignees.Nodes {
				users = append(users, u.Login)
			}
			if login != "" && !contains(users, login) {
				continue
			}
			rows = append(
				rows,
				output.R(
					"number",
					v.Content.Number,
					"status",
					fallback(fields["Status"]),
					"assignees",
					join(users),
					"title",
					v.Content.Title,
				),
			)
		}
		if !page.PageInfo.HasNextPage {
			break
		}
		cursor = page.PageInfo.EndCursor
	}
	return r.rows(rows...)
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func fallback(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}
