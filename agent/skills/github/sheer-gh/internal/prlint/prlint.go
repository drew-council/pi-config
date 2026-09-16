package prlint

import (
	"fmt"
	"regexp"
	"strings"
)

type Result struct{ Failures, Warnings, OK []string }

var (
	comments = regexp.MustCompile(`(?s)<!--.*?-->`)
	refs     = regexp.MustCompile(
		`#[0-9]+|github\.com/sheerhealth/sheer/issues/[0-9]+|security/dependabot/[0-9]+`,
	)
)

func Check(body string, changed int, labels []string, headings []string) Result {
	var r Result
	body = strings.ReplaceAll(body, "\r", "")
	if strings.Contains(body, "<!--") {
		r.Warnings = append(r.Warnings, "template comments are still in the body; delete them")
	}
	body = comments.ReplaceAllString(body, "")
	last := -1
	for _, h := range headings {
		p := strings.Index(body, h)
		if p < 0 {
			r.Failures = append(r.Failures, fmt.Sprintf("missing heading %q", h))
			continue
		}
		if p < last {
			r.Failures = append(r.Failures, fmt.Sprintf("heading %q is out of template order", h))
		}
		last = p
		after := body[p+len(h):]
		if n := strings.Index(after, "\n## "); n >= 0 {
			after = after[:n]
		}
		if strings.TrimSpace(after) == "" && !strings.Contains(h, "External Testing") {
			r.Warnings = append(r.Warnings, fmt.Sprintf("section %q is empty", h))
		}
	}
	if !refs.MatchString(body) {
		debt := false
		for _, l := range labels {
			debt = debt || strings.Contains(l, "debt")
		}
		if debt {
			r.OK = append(r.OK, "no issue linked, allowed by the 'debt' label")
		} else if changed > 0 && changed <= 50 {
			r.OK = append(
				r.OK,
				fmt.Sprintf("no issue linked, allowed for a diff of %d lines", changed),
			)
		} else {
			r.Failures = append(
				r.Failures,
				"no issue linked; the check-linked-issue workflow fails PRs over 50 lines without one",
			)
		}
	} else if !regexp.MustCompile(`(Closes|Fixes|Resolves) `).MatchString(body) {
		r.Warnings = append(r.Warnings, "issue is mentioned without a closing keyword")
	}
	checks := []struct {
		re  *regexp.Regexp
		msg string
	}{{regexp.MustCompile(`(?i)\bstack(ed)?\b|previous in stack|next in stack|part [0-9]+ of`), "references the stack"}, {regexp.MustCompile(`(?i)not (in|part of) this PR|does not include|out of scope|will (be|come) (in|as) a follow`), "describes what is not in the PR"}, {regexp.MustCompile(`—`), "contains an em dash"}, {regexp.MustCompile(`Generated with|Co-Authored-By`), "has a generated-with trailer"}}
	for _, c := range checks {
		if c.re.MatchString(body) {
			r.Warnings = append(r.Warnings, c.msg)
		}
	}
	if n := len(strings.Fields(body)); n > 300 {
		r.Warnings = append(
			r.Warnings,
			fmt.Sprintf("%d words; most merged PR bodies are under 200", n),
		)
	}
	return r
}
