package app

import (
	"bytes"
	"testing"
)

func TestHelpForEveryGroup(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test")
	for _, group := range []string{"ci", "pr", "issue", "sprint", "discussion", "release", "wiki"} {
		var out, stderr bytes.Buffer
		code := Run([]string{"sheer-gh", group, "--help"}, &out, &stderr)
		if code != 0 {
			t.Fatalf("%s help exited %d: %s", group, code, stderr.String())
		}
		if out.Len() == 0 {
			t.Fatalf("%s help was empty", group)
		}
	}
}
