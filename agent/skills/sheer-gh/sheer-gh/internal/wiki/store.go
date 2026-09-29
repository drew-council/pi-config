package wiki

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Match struct {
	Page  string
	Lines []string
}
type Store struct{ Dir, URL string }

func (s Store) NeedsSync(now time.Time) bool {
	info, err := os.Stat(filepath.Join(s.Dir, ".git", "FETCH_HEAD"))
	return err != nil || now.Sub(info.ModTime()) > 24*time.Hour
}

func (s Store) Sync() error {
	if _, err := os.Stat(filepath.Join(s.Dir, ".git")); err != nil {
		if err := exec.Command("git", "clone", "-q", s.URL, s.Dir).Run(); err != nil {
			return fmt.Errorf("clone wiki: %w", err)
		}
		return nil
	}
	if err := exec.Command("git", "-C", s.Dir, "pull", "-q", "--ff-only").Run(); err != nil {
		return fmt.Errorf("pull wiki: %w", err)
	}
	return nil
}

func (s Store) Files() ([]string, error) {
	files, err := filepath.Glob(filepath.Join(s.Dir, "*.md"))
	if err != nil {
		return nil, err
	}
	out := files[:0]
	for _, f := range files {
		if !strings.HasPrefix(filepath.Base(f), "_") {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out, nil
}

func Title(path string) string {
	return strings.ReplaceAll(strings.TrimSuffix(filepath.Base(path), ".md"), "-", " ")
}

func (s Store) Resolve(want string) (string, error) {
	files, err := s.Files()
	if err != nil {
		return "", err
	}
	norm := strings.ToLower(strings.ReplaceAll(want, " ", "-"))
	groups := [][]string{{}, {}, {}}
	for _, f := range files {
		b := strings.ToLower(strings.TrimSuffix(filepath.Base(f), ".md"))
		switch {
		case b == norm:
			groups[0] = append(groups[0], f)
		case strings.HasPrefix(b, norm):
			groups[1] = append(groups[1], f)
		case strings.Contains(b, norm):
			groups[2] = append(groups[2], f)
		}
	}
	for _, hits := range groups {
		if len(hits) == 1 {
			return hits[0], nil
		}
		if len(hits) > 1 {
			titles := make([]string, len(hits))
			for i, h := range hits {
				titles[i] = Title(h)
			}
			return "", fmt.Errorf("ambiguous %q; matches: %s", want, strings.Join(titles, ", "))
		}
	}
	return "", fmt.Errorf("no page matches %q", want)
}

func (s Store) Search(words string) ([]Match, error) {
	files, err := s.Files()
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(words)
	var out []Match
	for _, f := range files {
		h, err := os.Open(f)
		if err != nil {
			return nil, err
		}
		scanner := bufio.NewScanner(h)
		line := 0
		var found []string
		for scanner.Scan() {
			line++
			text := scanner.Text()
			if strings.Contains(strings.ToLower(text), needle) && len(found) < 5 {
				v := fmt.Sprintf("%d:%s", line, text)
				if len(v) > 200 {
					v = v[:200]
				}
				found = append(found, v)
			}
		}
		h.Close()
		if len(found) > 0 {
			out = append(out, Match{Page: Title(f), Lines: found})
		}
	}
	return out, nil
}
