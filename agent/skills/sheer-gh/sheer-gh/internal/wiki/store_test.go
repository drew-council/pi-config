package wiki

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAndSearch(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Git-Worktrees.md"), []byte("Bazel cache here\n"), 0o600)
	os.WriteFile(filepath.Join(d, "Git-Other.md"), []byte("nothing\n"), 0o600)
	s := Store{Dir: d}
	got, err := s.Resolve("worktrees")
	if err != nil || filepath.Base(got) != "Git-Worktrees.md" {
		t.Fatalf("%q %v", got, err)
	}
	matches, err := s.Search("bazel cache")
	if err != nil || len(matches) != 1 || matches[0].Page != "Git Worktrees" {
		t.Fatalf("%#v %v", matches, err)
	}
}
