// Package convo renders an issue, pull request, or discussion and its
// comments as one markdown document with downloaded attachments.
package convo

import (
	"fmt"
	"sort"
	"strings"
)

// Post is a comment, review, review thread, or reply.
type Post struct {
	Kind   string // comment, review, thread, reply
	ID     string
	Author string
	Time   string // RFC 3339, used for ordering; the date part is rendered
	Note   string // extra heading text, such as a review state or file:line
	Body   string
	HTML   string // GitHub's rendering of Body, used to find attachments
	Posts  []Post
}

// Doc is the top-level item with its conversation.
type Doc struct {
	Slug   string // issue-28404, pr-28298, discussion-875
	Title  string
	Header []string
	Body   string
	HTML   string
	Posts  []Post
	Files  []File
	Dir    string
}

// Sort orders top-level posts by time, keeping replies in place.
func (d *Doc) Sort() {
	sort.SliceStable(d.Posts, func(i, j int) bool { return d.Posts[i].Time < d.Posts[j].Time })
}

// Markdown renders the document, its posts, and the attachment list.
func (d *Doc) Markdown() string {
	var b strings.Builder
	if d.Title != "" {
		fmt.Fprintf(&b, "# %s\n\n", d.Title)
		if len(d.Header) > 0 {
			b.WriteString(strings.Join(d.Header, "\n") + "\n\n")
		}
		b.WriteString(strings.TrimSpace(d.Body) + "\n")
	}
	for _, p := range d.Posts {
		if d.Title != "" || b.Len() > 0 {
			b.WriteString("\n---\n\n")
		}
		writePost(&b, p, 2)
	}
	if len(d.Files) > 0 {
		fmt.Fprintf(&b, "\n---\n\nattachments in %s:\n", d.Dir)
		for _, f := range d.Files {
			if f.Err != nil {
				fmt.Fprintf(&b, "  FAILED %s: %v\n", f.URL, f.Err)
			} else {
				fmt.Fprintf(&b, "  %s  <-  %s\n", f.Path, f.URL)
			}
		}
	}
	return b.String()
}

func writePost(b *strings.Builder, p Post, level int) {
	parts := []string{strings.Repeat("#", level), p.Kind}
	if p.ID != "" {
		parts = append(parts, p.ID)
	}
	if p.Author != "" {
		parts = append(parts, "@"+p.Author)
	}
	if len(p.Time) >= 10 {
		parts = append(parts, p.Time[:10])
	}
	if p.Note != "" {
		parts = append(parts, p.Note)
	}
	b.WriteString(strings.Join(parts, " ") + "\n\n")
	if body := strings.TrimSpace(p.Body); body != "" {
		b.WriteString(body + "\n\n")
	}
	for _, child := range p.Posts {
		writePost(b, child, level+1)
	}
}

// each visits the document body and every post, allowing edits.
func (d *Doc) each(fn func(body, html *string)) {
	fn(&d.Body, &d.HTML)
	var walk func(ps []Post)
	walk = func(ps []Post) {
		for i := range ps {
			fn(&ps[i].Body, &ps[i].HTML)
			walk(ps[i].Posts)
		}
	}
	walk(d.Posts)
}
