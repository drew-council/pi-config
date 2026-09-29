package body

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func Read(inline, file, cwd string, stdin io.Reader) (string, error) {
	if inline != "" && file != "" {
		return "", fmt.Errorf("use only one of --body and --body-file")
	}
	if file == "" {
		if inline == "" {
			return "", fmt.Errorf("--body or --body-file is required")
		}
		return inline, nil
	}
	if file == "-" {
		data, err := io.ReadAll(stdin)
		return string(data), err
	}
	if !filepath.IsAbs(file) {
		file = filepath.Join(cwd, file)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func Attribution(text, agent, login string) string {
	if agent == "" {
		agent = "an AI coding agent"
	}
	return fmt.Sprintf(
		"> _Written by %s on behalf of @%s._\n\n%s",
		agent,
		login,
		strings.TrimSpace(text),
	)
}
