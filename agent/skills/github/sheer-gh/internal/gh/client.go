package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/google/go-github/v66/github"
)

type Runner func(context.Context, string, ...string) ([]byte, error)

func Token(ctx context.Context, run Runner) (string, error) {
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		return token, nil
	}
	if run == nil {
		run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).Output()
		}
	}
	out, err := run(ctx, "gh", "auth", "token")
	if err == nil && strings.TrimSpace(string(out)) == "" {
		err = errors.New("empty token")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && len(exit.Stderr) > 0 {
		err = errors.New(strings.TrimSpace(string(exit.Stderr)))
	}
	if err != nil {
		return "", fmt.Errorf(
			"no GitHub token (gh auth token: %v); run: gh auth login, or set GITHUB_TOKEN",
			err,
		)
	}
	return strings.TrimSpace(string(out)), nil
}

type Client struct {
	REST       *github.Client
	token      string
	http       *http.Client
	GraphQLURL string
}

func New(token string) *Client {
	h := &http.Client{}
	return &Client{
		REST:       github.NewClient(h).WithAuthToken(token),
		token:      token,
		http:       h,
		GraphQLURL: "https://api.github.com/graphql",
	}
}

func (c *Client) GraphQL(
	ctx context.Context,
	query string,
	variables map[string]any,
	target any,
) error {
	payload, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.GraphQLURL,
		bytes.NewReader(payload),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var envelope struct {
		Data    json.RawMessage `json:"data"`
		Message string          `json:"message"` // set on HTTP-level failures
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil && resp.StatusCode < 300 {
		return err
	}
	if resp.StatusCode >= 300 {
		if envelope.Message == "" {
			envelope.Message = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("github graphql: %s: %s", resp.Status, envelope.Message)
	}
	if len(envelope.Errors) > 0 {
		return errors.New(envelope.Errors[0].Message)
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, target)
}

var scopesRE = regexp.MustCompile(`scopes: \['([^']+)'`)

// Hint appends the command that fixes a GitHub authentication or scope failure.
func Hint(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	var resp *github.ErrorResponse
	status := 0
	if errors.As(err, &resp) && resp.Response != nil {
		status = resp.Response.StatusCode
	}
	switch {
	case status == http.StatusUnauthorized || strings.Contains(lower, "bad credentials"):
		return fmt.Errorf("%w; GitHub rejected the token, run: gh auth login", err)
	case strings.Contains(lower, "scope"):
		scope := "project"
		if m := scopesRE.FindStringSubmatch(msg); m != nil {
			scope = m[1]
		}
		return fmt.Errorf("%w; run: gh auth refresh -s %s", err, scope)
	case strings.Contains(lower, "resource not accessible"):
		return fmt.Errorf("%w; run: gh auth refresh -s repo,project", err)
	}
	return err
}
