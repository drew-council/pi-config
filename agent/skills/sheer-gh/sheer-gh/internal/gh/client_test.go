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

func TestHint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(
			w,
			`{"errors":[{"message":"Your token has not been granted the required scopes to execute this query. The 'projectItems' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo'] scopes."}]}`,
		)
	}))
	defer server.Close()
	c := New("token")
	c.GraphQLURL = server.URL
	err := Hint(c.GraphQL(context.Background(), "query {}", nil, nil))
	if err == nil || !strings.Contains(err.Error(), "run: gh auth refresh -s read:project") {
		t.Fatalf("%v", err)
	}
	err = Hint(fmt.Errorf("github graphql: 401 Unauthorized: {\"message\":\"Bad credentials\"}"))
	if err == nil || !strings.Contains(err.Error(), "run: gh auth login") {
		t.Fatalf("%v", err)
	}
	if Hint(nil) != nil || Hint(fmt.Errorf("boom")).Error() != "boom" {
		t.Fatal("hint changed an unrelated error")
	}
	_, err = Token(
		context.Background(),
		func(context.Context, string, ...string) ([]byte, error) { return nil, fmt.Errorf("exit 1") },
	)
	if err == nil || !strings.Contains(err.Error(), "run: gh auth login") {
		t.Fatalf("%v", err)
	}
}
