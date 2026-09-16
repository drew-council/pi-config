package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/google/go-github/v66/github"

	"github.com/drew-council/sheer-gh/internal/config"
	ghclient "github.com/drew-council/sheer-gh/internal/gh"
	"github.com/drew-council/sheer-gh/internal/output"
)

type Runtime struct {
	Config   config.Config
	GH       *ghclient.Client
	Out, Err io.Writer
	In       io.Reader
}

func runtime(c config.Config, token string) *Runtime {
	return &Runtime{
		Config: c,
		GH:     ghclient.New(token),
		Out:    os.Stdout,
		Err:    os.Stderr,
		In:     os.Stdin,
	}
}

func (r *Runtime) rows(
	rows ...output.Row,
) error {
	return output.Render(r.Out, rows, r.Config.JSON)
}

func (r *Runtime) dry(format string, args ...any) bool {
	if !r.Config.DryRun {
		return false
	}
	fmt.Fprintf(r.Out, "[dry-run] "+format+"\n", args...)
	return true
}

func (r *Runtime) get(ctx context.Context, path string, target any) error {
	req, err := r.GH.REST.NewRequest("GET", path, nil)
	if err != nil {
		return err
	}
	_, err = r.GH.REST.Do(ctx, req, target)
	return err
}

func (r *Runtime) post(ctx context.Context, path string, body, target any) error {
	req, err := r.GH.REST.NewRequest("POST", path, body)
	if err != nil {
		return err
	}
	_, err = r.GH.REST.Do(ctx, req, target)
	return err
}

func (r *Runtime) stream(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("download logs: %s", resp.Status)
	}
	_, err = io.Copy(r.Out, resp.Body)
	return err
}

func (r *Runtime) template(ctx context.Context, path string) (string, error) {
	f, _, _, err := r.GH.REST.Repositories.GetContents(
		ctx,
		r.Config.Owner,
		r.Config.Repo,
		path,
		nil,
	)
	if err != nil {
		return "", err
	}
	if f == nil {
		return "", fmt.Errorf("%s is a directory", path)
	}
	return f.GetContent()
}

func labels(ls []*github.Label) []string {
	out := make([]string, 0, len(ls))
	for _, l := range ls {
		out = append(out, l.GetName())
	}
	return out
}

func join(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, ",")
}
