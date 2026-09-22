import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRepositoryRoot, isSheerWorkspace, sheerWorkspaceFor } from "../../extensions/shared/sheer-workspace.js";
import guardExtension, { _test, guardCommand } from "../../extensions/sheer-bazel-guard.js";

// A fake home with the Sheer checkout, a linked worktree, and unrelated repositories.
const home = mkdtempSync(join(tmpdir(), "pi-sheer-guard-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const sheer = join(home, "work", "sheer");
const worktree = join(home, ".herdr", "worktrees", "sheer", "feature");
const other = join(home, "work", "other-go-repo");
const personal = join(home, "personal", "sheer");
const scratch = join(home, "scratch");
mkdirSync(join(sheer, ".git", "worktrees", "feature"), { recursive: true });
mkdirSync(join(sheer, "internal", "claims"), { recursive: true });
mkdirSync(join(worktree, "cmd", "local"), { recursive: true });
writeFileSync(join(worktree, ".git"), `gitdir: ${join(sheer, ".git", "worktrees", "feature")}\n`);
mkdirSync(join(other, ".git"), { recursive: true });
mkdirSync(join(personal, ".git"), { recursive: true });
mkdirSync(scratch, { recursive: true });

const guard = (command: string, cwd = sheer) => guardCommand(command, cwd, home);

describe("workspace detection", () => {
  test("recognizes the main checkout, nested directories, and linked worktrees", () => {
    expect(findRepositoryRoot(join(sheer, "internal", "claims"))).toEqual({ root: sheer, main: sheer });
    expect(findRepositoryRoot(join(worktree, "cmd"))).toEqual({ root: worktree, main: sheer });
    expect(isSheerWorkspace(sheer, home)).toBeTrue();
    expect(isSheerWorkspace(join(sheer, "internal", "claims"), home)).toBeTrue();
    expect(sheerWorkspaceFor(join(worktree, "cmd", "local"), home)?.root).toBe(worktree);
  });

  test("ignores other repositories, same-named repositories elsewhere, and directories without a checkout", () => {
    expect(isSheerWorkspace(other, home)).toBeFalse();
    expect(isSheerWorkspace(personal, home)).toBeFalse();
    expect(isSheerWorkspace(scratch, home)).toBeFalse();
    expect(isSheerWorkspace("/tmp", home)).toBeFalse();
    expect(findRepositoryRoot(scratch)).toBeUndefined();
  });
});

describe("command parsing", () => {
  test("splits chained, piped, multi-line, and subshell commands while tracking cd", () => {
    const segments = _test.splitSegments(
      'cd internal && go test ./... | tee out.txt; (cd /tmp && go build .)\nVAR="a b" go vet',
      sheer,
      home,
    );
    expect(segments.map((segment) => segment.words)).toEqual([
      ["cd", "internal"],
      ["go", "test", "./..."],
      ["tee", "out.txt"],
      ["cd", "/tmp"],
      ["go", "build", "."],
      ["VAR=a b", "go", "vet"],
    ]);
    expect(segments.map((segment) => segment.cwd)).toEqual([
      sheer,
      join(sheer, "internal"),
      join(sheer, "internal"),
      join(sheer, "internal"),
      "/tmp",
      join(sheer, "internal"),
    ]);
  });

  test("finds go subcommands behind env assignments and wrappers, and only blocked ones", () => {
    expect(_test.parseGoInvocation(["CGO_ENABLED=0", "GOFLAGS=-mod=mod", "go", "test", "./..."])).toEqual({
      subcommand: "test",
      args: ["./..."],
    });
    expect(_test.parseGoInvocation(["env", "-i", "FOO=1", "go", "build", "./cmd"])?.subcommand).toBe("build");
    expect(_test.parseGoInvocation(["timeout", "-k", "5", "60", "go", "test", "."])?.subcommand).toBe("test");
    expect(_test.parseGoInvocation(["/usr/local/go/bin/go", "vet", "./..."])?.subcommand).toBe("vet");
    for (const words of [
      ["go", "version"],
      ["go", "env", "GOPATH"],
      ["go", "list", "-m", "all"],
      ["go", "doc", "fmt.Println"],
      ["go", "mod", "tidy"],
      ["go", "tool", "-modfile=go-tools.mod", "golangci-lint", "run"],
      ["bazel", "run", "@io_bazel_rules_go//go", "--", "generate", "./..."],
      ["cargo", "test"],
      ["echo", "go", "test"],
    ]) {
      expect(_test.parseGoInvocation(words)).toBeUndefined();
    }
  });
});

describe("guidance", () => {
  test("translates package paths into labels relative to the repository root", () => {
    expect(guard("go test ./internal/claims/...")).toContain("Use instead: bazel test //internal/claims/...");
    expect(guard("go test internal/claims/...")).toContain("bazel test //internal/claims/...");
    expect(guard("go test ./...")).toContain("bazel test //...");
    expect(guard("go test ./internal/claims")).toContain("bazel test //internal/claims:all");
    expect(guard("go test", join(sheer, "internal", "claims"))).toContain("bazel test //internal/claims:all");
    expect(guard("go test ./...", join(sheer, "internal"))).toContain("bazel test //internal/...");
    expect(guard("cd internal/claims && go test ./...")).toContain("bazel test //internal/claims/...");
    expect(guard("go test ./internal/claims/claims_test.go")).toContain("bazel test //internal/claims:all");
    expect(guard("go build ./cmd/local/...", worktree)).toContain("Use instead: bazel build //cmd/local/...");
    expect(guard("go build ./cmd/local/... ./internal/...")).toContain("bazel build //cmd/local/... //internal/...");
  });

  test("carries go test flags into their Bazel equivalents", () => {
    expect(guard("go test -run TestFoo -v -count=1 ./internal/claims/...")).toContain(
      "bazel test //internal/claims/... --test_filter=TestFoo --test_output=all --nocache_test_results",
    );
    expect(guard("go test -run=TestFoo/Sub ./internal/claims")).toContain("--test_filter=TestFoo/Sub");
    expect(guard("go test -timeout 30s ./internal/claims")).not.toContain("30s");
  });

  test("routes vet, generate, and run to their project-standard replacements", () => {
    const vet = guard("go vet ./internal/claims/...");
    expect(vet).toContain("nogo");
    expect(vet).toContain("Use instead: bazel build //internal/claims/... (or scripts/golangci-lint.sh run)");
    expect(guard("go generate ./internal/claims/...")).toContain(
      "Use instead (from the repository root): make generate PKG=./internal/claims/...",
    );
    expect(guard("go generate ./...")).toMatch(/make generate$/);
    expect(guard("go generate ./...", join(sheer, "internal"))).toContain("make generate PKG=./internal/...");
    expect(guard("go generate -run cmd/graph/gen ./...", worktree)).toMatch(/make generate$/);
    expect(guard("go run ./cmd/local")).toContain("Use instead: bazel run //cmd/local:all");
  });

  test("keeps arguments that point outside the repository out of the suggestion", () => {
    expect(guard("go test ../other-go-repo/...")).toContain("bazel test //path/to/package/...");
  });
});

describe("scope", () => {
  test("allows go commands outside Sheer and in segments that cd away from it", () => {
    expect(guard("go test ./...", other)).toBeUndefined();
    expect(guard("go test ./...", personal)).toBeUndefined();
    expect(guard("go build ./...", scratch)).toBeUndefined();
    expect(guard("cd /tmp/scopetry && go build ./...")).toBeUndefined();
    expect(guard(`cd ${other} && go test ./...`)).toBeUndefined();
    expect(guard("(cd /tmp && go build .) && go version")).toBeUndefined();
  });

  test("blocks go commands that cd into Sheer or back out of a subshell", () => {
    expect(guard(`cd ~/work/sheer && go test ./...`, scratch)).toContain("bazel test //...");
    expect(guard("(cd /tmp && go build .) && go test ./...")).toContain("bazel test //...");
    expect(guard("go version && go test ./internal/claims")).toContain("bazel test //internal/claims:all");
  });

  test("allows read-only and non-go commands in Sheer", () => {
    for (const command of [
      "go version",
      "go env GOMODCACHE",
      "go list ./...",
      "go doc net/http",
      "go mod tidy",
      "scripts/golangci-lint.sh run",
      "bazel test //internal/claims/...",
      "bazel run @io_bazel_rules_go//go -- generate ./...",
      "make generate PKG=./internal/claims/...",
      "grep -rn 'go test' docs/",
    ]) {
      expect(guard(command)).toBeUndefined();
    }
  });
});

describe("tool_call hook", () => {
  type Handler = (
    event: { toolName: string; input: Record<string, unknown> },
    ctx: { cwd: string; hasUI: boolean; ui: { notify(message: string, level: string): void } },
  ) => { block: true; reason: string } | undefined;

  function register(): Handler {
    let handler: Handler | undefined;
    guardExtension({
      on(event: string, candidate: Handler) {
        if (event === "tool_call") handler = candidate;
      },
    } as unknown as ExtensionAPI);
    if (!handler) throw new Error("guard did not register a tool_call hook");
    return handler;
  }

  test("blocks only bash calls, and only outside the real Sheer checkout when the cwd is elsewhere", () => {
    const handler = register();
    const notifications: string[] = [];
    const ctx = { cwd: scratch, hasUI: true, ui: { notify: (message: string) => notifications.push(message) } };
    expect(handler({ toolName: "bash", input: { command: "go test ./..." } }, ctx)).toBeUndefined();
    expect(handler({ toolName: "edit", input: { path: "main.go" } }, ctx)).toBeUndefined();
    expect(handler({ toolName: "bash", input: { command: 42 } }, ctx)).toBeUndefined();
    expect(notifications).toEqual([]);
  });
});
