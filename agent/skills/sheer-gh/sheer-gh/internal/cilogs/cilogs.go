package cilogs

import (
	"bufio"
	"io"
	"regexp"
	"sort"
	"strings"
)

var (
	timestamp = regexp.MustCompile(`^[0-9T:.Z-]+ `)
	patterns  = []string{
		"##[error]",
		"--- FAIL",
		"FAIL",
		"FAILED",
		"panic:",
		"TIMEOUT",
		"Error:",
		"error:",
	}
)

func Errors(r io.Reader) []string {
	seen := map[string]bool{}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if parts := strings.SplitN(line, "\t", 3); len(parts) == 3 {
			line = parts[2]
		}
		line = timestamp.ReplaceAllString(line, "")
		match := false
		for _, p := range patterns {
			if strings.Contains(line, p) {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		if len(line) > 240 {
			line = line[:240]
		}
		seen[line] = true
	}
	lines := make([]string, 0, len(seen))
	for line := range seen {
		lines = append(lines, line)
	}
	sort.Strings(lines)
	if len(lines) > 40 {
		lines = lines[:40]
	}
	return lines
}
