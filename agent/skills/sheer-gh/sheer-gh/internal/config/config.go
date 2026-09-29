package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	DefaultOwner   = "sheerhealth"
	DefaultRepo    = "sheer"
	DefaultProject = 9
)

type Config struct {
	Owner, Repo, CWD, WikiDir string
	Project                   int
	JSON, DryRun              bool
}

func From(repo, cwd string, jsonOutput, dryRun bool) (Config, error) {
	owner, name := env("SHEER_GH_OWNER", DefaultOwner), env("SHEER_GH_REPO", DefaultRepo)
	if repo != "" {
		parts := strings.Split(repo, "/")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return Config{}, fmt.Errorf("--repo must be owner/name")
		}
		owner, name = parts[0], parts[1]
	}
	if cwd == "" {
		cwd = os.Getenv("PWD")
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	project, err := strconv.Atoi(env("SHEER_GH_PROJECT", strconv.Itoa(DefaultProject)))
	if err != nil {
		return Config{}, fmt.Errorf("invalid SHEER_GH_PROJECT: %w", err)
	}
	wiki := os.Getenv("SHEER_WIKI_DIR")
	if wiki == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			return Config{}, err
		}
		wiki = filepath.Join(cache, "sheer-wiki")
	}
	return Config{
		Owner:   owner,
		Repo:    name,
		CWD:     cwd,
		WikiDir: wiki,
		Project: project,
		JSON:    jsonOutput,
		DryRun:  dryRun,
	}, nil
}

func (c Config) Slug() string { return c.Owner + "/" + c.Repo }
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
