package gh

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestToken(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "env-token")
	got, err := Token(
		context.Background(),
		func(context.Context, string, ...string) ([]byte, error) { return nil, fmt.Errorf("must not run") },
	)
	if err != nil || got != "env-token" {
		t.Fatalf("%q %v", got, err)
	}
	os.Unsetenv("GITHUB_TOKEN")
	got, err = Token(
		context.Background(),
		func(context.Context, string, ...string) ([]byte, error) { return []byte("gh-token\n"), nil },
	)
	if err != nil || got != "gh-token" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestGraphQL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing auth")
		}
		fmt.Fprint(w, `{"data":{"viewer":{"login":"drew"}}}`)
	}))
	defer server.Close()
	c := New("token")
	c.GraphQLURL = server.URL
	var out struct{ Viewer struct{ Login string } }
	if err := c.GraphQL(
		context.Background(),
		"query {}",
		nil,
		&out,
	); err != nil ||
		out.Viewer.Login != "drew" {
		t.Fatalf("%#v %v", out, err)
	}
}

func TestGraphQLErrorScopeHint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"errors":[{"message":"project scope required"}]}`)
	}))
	defer server.Close()
	c := New("token")
	c.GraphQLURL = server.URL
	err := c.GraphQL(context.Background(), "query {}", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "gh auth refresh -s project") {
		t.Fatalf("%v", err)
	}
}
