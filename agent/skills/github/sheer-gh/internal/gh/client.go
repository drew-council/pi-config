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
	if err != nil {
		return "", fmt.Errorf("get token with gh auth token: %w", err)
	}
	if token := strings.TrimSpace(string(out)); token != "" {
		return token, nil
	}
	return "", errors.New("gh auth token returned an empty token")
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
	if resp.StatusCode >= 300 {
		return fmt.Errorf("github graphql: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	if len(envelope.Errors) > 0 {
		return ScopeHint(errors.New(envelope.Errors[0].Message))
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, target)
}

func ScopeHint(err error) error {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "project") &&
		(strings.Contains(lower, "scope") || strings.Contains(lower, "resource not accessible")) {
		return fmt.Errorf("%w; run: gh auth refresh -s project", err)
	}
	return err
}
