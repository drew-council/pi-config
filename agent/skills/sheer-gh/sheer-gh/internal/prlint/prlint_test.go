package prlint

import (
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	headings := []string{"## Summary", "## Testing"}
	good := Check("## Summary\nFixes #12\n\n## Testing\nunit tests", 100, nil, headings)
	if len(good.Failures) != 0 {
		t.Fatalf("unexpected failures %#v", good)
	}
	bad := Check("## Testing\nGenerated with bot — stacked", 100, nil, headings)
	if len(bad.Failures) < 2 {
		t.Fatalf("expected heading and issue failures: %#v", bad)
	}
	joined := strings.Join(bad.Warnings, " ")
	for _, word := range []string{"stack", "em dash", "generated"} {
		if !strings.Contains(joined, word) {
			t.Errorf("missing warning %q in %q", word, joined)
		}
	}
}

func TestIssueExceptions(t *testing.T) {
	if got := Check("", 10, nil, nil); len(got.Failures) != 0 {
		t.Fatal(got)
	}
	if got := Check("", 100, []string{"debt"}, nil); len(got.Failures) != 0 {
		t.Fatal(got)
	}
}
