package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/urfave/cli/v2"

	"github.com/drew-council/sheer-gh/internal/convo"
)

// postFields are the GraphQL fields every comment-like node is fetched with.
const postFields = `databaseId author{login} createdAt body bodyHTML`

type post struct {
	DatabaseID            int64
	Author                struct{ Login string }
	CreatedAt             string
	Body, BodyHTML, State string
	Replies               struct{ Nodes []post }
}

type page struct {
	PageInfo struct {
		HasNextPage bool
		EndCursor   string
	}
	Nodes []post
}

func (p post) convo(kind string) convo.Post {
	out := convo.Post{
		Kind:   kind,
		Author: p.Author.Login,
		Time:   p.CreatedAt,
		Body:   p.Body,
		HTML:   p.BodyHTML,
	}
	if p.DatabaseID != 0 {
		out.ID = strconv.FormatInt(p.DatabaseID, 10)
	}
	for _, reply := range p.Replies.Nodes {
		out.Posts = append(out.Posts, reply.convo("reply"))
	}
	return out
}

func showFlags() []cli.Flag {
	return []cli.Flag{
		&cli.BoolFlag{Name: "no-comments"},
		&cli.BoolFlag{Name: "no-attachments"},
	}
}

// moreComments follows comment pagination for an issue or pull request.
func moreComments(ctx context.Context, r *Runtime, n int, pg page) ([]post, error) {
	posts := pg.Nodes
	for pg.PageInfo.HasNextPage {
		var d struct {
			Repository struct{ IssueOrPullRequest struct{ Comments page } }
		}
		comments := `comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{` + postFields + `}}`
		if err := r.GH.GraphQL(
			ctx,
			`query($owner:String!,$repo:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$repo){issueOrPullRequest(number:$number){... on Issue{`+comments+`} ... on PullRequest{`+comments+`}}}}`,
			map[string]any{
				"owner":  r.Config.Owner,
				"repo":   r.Config.Repo,
				"number": n,
				"cursor": pg.PageInfo.EndCursor,
			},
			&d,
		); err != nil {
			return nil, err
		}
		pg = d.Repository.IssueOrPullRequest.Comments
		posts = append(posts, pg.Nodes...)
	}
	return posts, nil
}

func gcloudToken(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "gcloud", "auth", "print-access-token").Output()
	var exit *exec.ExitError
	switch {
	case errors.Is(err, exec.ErrNotFound):
		return "", errors.New(
			"gcloud is not installed; install the Google Cloud CLI, then run: gcloud auth login",
		)
	case errors.As(err, &exit):
		return "", fmt.Errorf(
			"gcloud auth print-access-token: %s; run: gcloud auth login",
			strings.TrimSpace(string(exit.Stderr)),
		)
	case err != nil:
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// show renders the document, downloads its attachments, and saves the
// markdown next to them under the temp directory.
func (r *Runtime) show(c *cli.Context, doc *convo.Doc) error {
	if trailingBool(c, "no-comments") {
		doc.Posts = nil
	}
	doc.Sort()
	dir := filepath.Join(os.TempDir(), "sheer-gh", doc.Slug)
	if !trailingBool(c, "no-attachments") {
		if err := doc.Attach(c.Context, dir, convo.Downloader{GCSToken: gcloudToken}); err != nil {
			return err
		}
	}
	md := doc.Markdown()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file := filepath.Join(dir, doc.Slug+".md")
	if err := os.WriteFile(file, []byte(md), 0o644); err != nil {
		return err
	}
	_, err := fmt.Fprintf(r.Out, "%s\nsaved: %s\n", md, file)
	return err
}
