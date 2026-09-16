package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v66/github"
	"github.com/urfave/cli/v2"
	"golang.org/x/sync/errgroup"

	"github.com/drew-council/sheer-gh/internal/cilogs"
	"github.com/drew-council/sheer-gh/internal/output"
	"github.com/drew-council/sheer-gh/internal/refs"
)

func ciCommand() *cli.Command {
	return &cli.Command{Name: "ci", Usage: "inspect GitHub Actions", Subcommands: []*cli.Command{
		{
			Name:   "list",
			Flags:  []cli.Flag{&cli.IntFlag{Name: "limit", Value: 20}},
			Action: ciList(false),
		},
		{Name: "latest", Action: ciList(true)},
		{Name: "checks", Action: ciChecks},
		{Name: "runs", Action: ciRuns},
		{Name: "jobs", Action: ciJobs},
		{Name: "failed", Action: ciFailed},
		{Name: "log", Action: ciLog},
		{Name: "rerun", Flags: []cli.Flag{&cli.BoolFlag{Name: "failed"}}, Action: ciRerun},
		{Name: "watch", Action: ciWatch},
	}}
}

func workflowOptions(limit int) *github.ListWorkflowRunsOptions {
	opt := &github.ListWorkflowRunsOptions{ListOptions: github.ListOptions{PerPage: limit}}
	return opt
}

func listRuns(
	ctx context.Context,
	r *Runtime,
	workflow string,
	limit int,
) ([]*github.WorkflowRun, error) {
	fetchLimit := limit
	if workflow != "" && fetchLimit < 100 {
		fetchLimit = 100
	}
	opt := workflowOptions(fetchLimit)
	var runs *github.WorkflowRuns
	var err error
	runs, _, err = r.GH.REST.Actions.ListRepositoryWorkflowRuns(
		ctx,
		r.Config.Owner,
		r.Config.Repo,
		opt,
	)
	if err != nil {
		return nil, err
	}
	if workflow == "" {
		return runs.WorkflowRuns, nil
	}
	var filtered []*github.WorkflowRun
	for _, run := range runs.WorkflowRuns {
		path := strings.TrimSuffix(filepath.Base(run.GetPath()), filepath.Ext(run.GetPath()))
		if run.GetName() == workflow || path == workflow ||
			strconv.FormatInt(run.GetWorkflowID(), 10) == workflow {
			filtered = append(filtered, run)
			if len(filtered) == limit {
				break
			}
		}
	}
	return filtered, nil
}

func runRows(runs []*github.WorkflowRun) []output.Row {
	rows := make([]output.Row, 0, len(runs))
	for _, v := range runs {
		conclusion := v.GetConclusion()
		if conclusion == "" {
			conclusion = "-"
		}
		rows = append(
			rows,
			output.R(
				"id",
				v.GetID(),
				"name",
				v.GetName(),
				"status",
				v.GetStatus(),
				"conclusion",
				conclusion,
				"event",
				v.GetEvent(),
				"branch",
				v.GetHeadBranch(),
				"created",
				v.GetCreatedAt().Format(time.RFC3339),
				"url",
				v.GetHTMLURL(),
			),
		)
	}
	return rows
}

func ciList(latest bool) cli.ActionFunc {
	return func(c *cli.Context) error {
		workflow := ""
		if c.NArg() > 0 {
			workflow = c.Args().First()
		}
		limit := c.Int("limit")
		if value := trailingValue(c, "limit"); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 1 {
				return cli.Exit("--limit must be a positive integer", 2)
			}
			limit = parsed
		}
		if latest {
			limit = 100
		}
		runs, err := listRuns(c.Context, rt(c), workflow, limit)
		if err != nil {
			return err
		}
		if latest {
			for _, run := range runs {
				if run.GetConclusion() != "skipped" {
					return rt(c).rows(runRows([]*github.WorkflowRun{run})...)
				}
			}
			return fmt.Errorf("no non-skipped workflow runs found")
		}
		return rt(c).rows(runRows(runs)...)
	}
}

func prSHA(ctx context.Context, r *Runtime, arg string) (string, error) {
	n, err := refs.Number(arg)
	if err != nil {
		return "", err
	}
	pr, _, err := r.GH.REST.PullRequests.Get(ctx, r.Config.Owner, r.Config.Repo, n)
	if err != nil {
		return "", err
	}
	return pr.GetHead().GetSHA(), nil
}

func ciRuns(c *cli.Context) error {
	if err := needArg(c, 0, "pr"); err != nil {
		return err
	}
	r := rt(c)
	sha, err := prSHA(c.Context, r, c.Args().First())
	if err != nil {
		return err
	}
	runs, _, err := r.GH.REST.Actions.ListRepositoryWorkflowRuns(
		c.Context,
		r.Config.Owner,
		r.Config.Repo,
		&github.ListWorkflowRunsOptions{HeadSHA: sha, ListOptions: github.ListOptions{PerPage: 30}},
	)
	if err != nil {
		return err
	}
	return r.rows(runRows(runs.WorkflowRuns)...)
}

func ciChecks(c *cli.Context) error {
	if err := needArg(c, 0, "pr"); err != nil {
		return err
	}
	r := rt(c)
	sha, err := prSHA(c.Context, r, c.Args().First())
	if err != nil {
		return err
	}
	var checks *github.ListCheckRunsResults
	var status *github.CombinedStatus
	g, ctx := errgroup.WithContext(c.Context)
	g.Go(func() error {
		var e error
		checks, _, e = r.GH.REST.Checks.ListCheckRunsForRef(
			ctx,
			r.Config.Owner,
			r.Config.Repo,
			sha,
			nil,
		)
		return e
	})
	g.Go(func() error {
		var e error
		status, _, e = r.GH.REST.Repositories.GetCombinedStatus(
			ctx,
			r.Config.Owner,
			r.Config.Repo,
			sha,
			nil,
		)
		return e
	})
	if err := g.Wait(); err != nil {
		return err
	}
	var rows []output.Row
	for _, v := range checks.CheckRuns {
		rows = append(
			rows,
			output.R(
				"type",
				"check",
				"name",
				v.GetName(),
				"status",
				v.GetStatus(),
				"conclusion",
				v.GetConclusion(),
				"url",
				v.GetHTMLURL(),
			),
		)
	}
	for _, v := range status.Statuses {
		rows = append(
			rows,
			output.R(
				"type",
				"status",
				"name",
				v.GetContext(),
				"status",
				v.GetState(),
				"conclusion",
				v.GetDescription(),
				"url",
				v.GetTargetURL(),
			),
		)
	}
	return r.rows(rows...)
}

func jobs(ctx context.Context, r *Runtime, id int64) ([]*github.WorkflowJob, error) {
	result, _, err := r.GH.REST.Actions.ListWorkflowJobs(
		ctx,
		r.Config.Owner,
		r.Config.Repo,
		id,
		&github.ListWorkflowJobsOptions{ListOptions: github.ListOptions{PerPage: 100}},
	)
	if err != nil {
		return nil, err
	}
	return result.Jobs, nil
}

func ciJobs(c *cli.Context) error {
	if err := needArg(c, 0, "run-id"); err != nil {
		return err
	}
	id, err := refs.RunID(c.Args().First())
	if err != nil {
		return err
	}
	js, err := jobs(c.Context, rt(c), id)
	if err != nil {
		return err
	}
	rows := make([]output.Row, 0, len(js))
	for _, j := range js {
		con := j.GetConclusion()
		if con == "" {
			con = "-"
		}
		rows = append(
			rows,
			output.R(
				"id",
				j.GetID(),
				"name",
				j.GetName(),
				"status",
				j.GetStatus(),
				"conclusion",
				con,
				"url",
				j.GetHTMLURL(),
			),
		)
	}
	return rt(c).rows(rows...)
}

func failedRun(ctx context.Context, r *Runtime, id int64) (string, error) {
	js, err := jobs(ctx, r, id)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "== run %d\n", id)
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(4)
	chunks := make([][]string, len(js))
	for i, j := range js {
		if j.GetConclusion() != "failure" {
			continue
		}
		fmt.Fprintf(&b, "  job %d  %s\n", j.GetID(), j.GetName())
		for _, s := range j.Steps {
			if s.GetConclusion() == "failure" {
				fmt.Fprintf(&b, "    step: %s\n", s.GetName())
			}
		}
		i, j := i, j
		g.Go(func() error {
			url, _, err := r.GH.REST.Actions.GetWorkflowJobLogs(
				gctx,
				r.Config.Owner,
				r.Config.Repo,
				j.GetID(),
				3,
			)
			if err != nil {
				return err
			}
			resp, err := httpGet(gctx, url.String())
			if err != nil {
				return err
			}
			defer resp.Close()
			chunks[i] = cilogs.Errors(resp)
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return "", err
	}
	b.WriteString("  -- error lines\n")
	for _, chunk := range chunks {
		for _, line := range chunk {
			fmt.Fprintf(&b, "    %s\n", line)
		}
	}
	return b.String(), nil
}

func httpGet(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("download logs: %s", resp.Status)
	}
	return resp.Body, nil
}

func ciFailed(c *cli.Context) error {
	if err := needArg(c, 0, "pr or run-id"); err != nil {
		return err
	}
	r := rt(c)
	arg := c.Args().First()
	var ids []int64
	if refs.IsRunID(arg) {
		id, _ := refs.RunID(arg)
		ids = []int64{id}
	} else {
		sha, err := prSHA(c.Context, r, arg)
		if err != nil {
			return err
		}
		runs, _, err := r.GH.REST.Actions.ListRepositoryWorkflowRuns(
			c.Context,
			r.Config.Owner,
			r.Config.Repo,
			&github.ListWorkflowRunsOptions{
				HeadSHA:     sha,
				ListOptions: github.ListOptions{PerPage: 30},
			},
		)
		if err != nil {
			return err
		}
		for _, run := range runs.WorkflowRuns {
			if run.GetConclusion() == "failure" {
				ids = append(ids, run.GetID())
			}
		}
	}
	if len(ids) == 0 {
		_, err := fmt.Fprintln(r.Out, "no failed runs")
		return err
	}
	g, ctx := errgroup.WithContext(c.Context)
	parts := make([]string, len(ids))
	for i, id := range ids {
		i, id := i, id
		g.Go(func() error { var err error; parts[i], err = failedRun(ctx, r, id); return err })
	}
	if err := g.Wait(); err != nil {
		return err
	}
	_, err := fmt.Fprint(r.Out, strings.Join(parts, ""))
	return err
}

func ciLog(c *cli.Context) error {
	if err := needArg(c, 0, "run-id"); err != nil {
		return err
	}
	r := rt(c)
	id, err := refs.RunID(c.Args().Get(0))
	if err != nil {
		return err
	}
	var url *url.URL
	if name := c.Args().Get(1); name != "" {
		js, err := jobs(c.Context, r, id)
		if err != nil {
			return err
		}
		for _, j := range js {
			if j.GetName() == name {
				url, _, err = r.GH.REST.Actions.GetWorkflowJobLogs(
					c.Context,
					r.Config.Owner,
					r.Config.Repo,
					j.GetID(),
					3,
				)
				break
			}
		}
		if url == nil && err == nil {
			return fmt.Errorf("no job named %q in run %d", name, id)
		}
	} else {
		url, _, err = r.GH.REST.Actions.GetWorkflowRunLogs(
			c.Context,
			r.Config.Owner,
			r.Config.Repo,
			id,
			3,
		)
	}
	if err != nil {
		return err
	}
	return r.stream(c.Context, url.String())
}

func ciRerun(c *cli.Context) error {
	if err := needArg(c, 0, "run-id"); err != nil {
		return err
	}
	r := rt(c)
	id, err := refs.RunID(c.Args().First())
	if err != nil {
		return err
	}
	failedOnly := trailingBool(c, "failed")
	if r.dry("rerun workflow %d failed-only=%t", id, failedOnly) {
		return nil
	}
	if failedOnly {
		_, err = r.GH.REST.Actions.RerunFailedJobsByID(c.Context, r.Config.Owner, r.Config.Repo, id)
	} else {
		_, err = r.GH.REST.Actions.RerunWorkflowByID(c.Context, r.Config.Owner, r.Config.Repo, id)
	}
	return err
}

func ciWatch(c *cli.Context) error {
	if err := needArg(c, 0, "run-id"); err != nil {
		return err
	}
	r := rt(c)
	id, err := refs.RunID(c.Args().First())
	if err != nil {
		return err
	}
	for {
		run, _, err := r.GH.REST.Actions.GetWorkflowRunByID(
			c.Context,
			r.Config.Owner,
			r.Config.Repo,
			id,
		)
		if err != nil {
			return err
		}
		if run.GetStatus() == "completed" {
			fmt.Fprintf(r.Out, "%s %s %s\n", run.GetStatus(), run.GetConclusion(), run.GetHTMLURL())
			js, err := jobs(c.Context, r, id)
			if err != nil {
				return err
			}
			for _, job := range js {
				fmt.Fprintf(r.Out, "  %s\t%s\n", job.GetName(), fallback(job.GetConclusion()))
			}
			return nil
		}
		time.Sleep(30 * time.Second)
	}
}
