package convo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// File is one attachment referenced by the conversation.
type File struct {
	URL      string // as written in the markdown
	Download string // where the bytes come from
	Name     string
	GCS      bool
	Path     string
	Err      error
}

const maxAttachment = 50 << 20

var (
	// GitHub rewrites user-attachments links in bodyHTML to short-lived signed URLs
	// whose file name carries the original asset UUID.
	signedRE = regexp.MustCompile(
		`https://private-user-images\.githubusercontent\.com/\d+/\d+-([0-9a-f-]{36})\.(\w+)\?[^"'\s<>]+`,
	)
	gcsRE = regexp.MustCompile(
		`https://(?:console\.cloud\.google\.com/storage/browser/_details|storage\.cloud\.google\.com|storage\.googleapis\.com)/([^/\s"'<>)]+)/([^\s"'<>);?]+)`,
	)
)

// Find lists the attachments referenced by a body and its HTML rendering.
func Find(body, html string) []File {
	var out []File
	for _, m := range signedRE.FindAllStringSubmatch(html, -1) {
		out = append(out, File{
			URL:      "https://github.com/user-attachments/assets/" + m[1],
			Download: m[0],
			Name:     m[1] + "." + m[2],
		})
	}
	for _, m := range gcsRE.FindAllStringSubmatch(body, -1) {
		bucket, object := m[1], strings.TrimRight(m[2], ".,")
		if bucket == "storage" || bucket == "download" { // JSON API URLs pasted from logs
			continue
		}
		if decoded, err := url.PathUnescape(object); err == nil {
			object = decoded
		}
		// macOS screenshot names carry a narrow no-break space; keep the local name typeable.
		name := strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) {
				return ' '
			}
			return r
		}, path.Base(object))
		out = append(out, File{
			URL: m[0],
			Download: "https://storage.googleapis.com/storage/v1/b/" + bucket + "/o/" +
				url.PathEscape(object) + "?alt=media",
			Name: name,
			GCS:  true,
		})
	}
	return out
}

// Downloader fetches attachments. GCSToken is called once, only when a
// Google Cloud Storage link is present.
type Downloader struct {
	HTTP     *http.Client
	GCSToken func(context.Context) (string, error)
}

// Attach downloads every attachment into dir and rewrites references in the
// document to the local paths. Failures are recorded per file, not returned.
func (d *Doc) Attach(ctx context.Context, dir string, dl Downloader) error {
	seen := map[string]bool{}
	var files []File
	d.each(func(body, html *string) {
		for _, f := range Find(*body, *html) {
			if !seen[f.URL] {
				seen[f.URL] = true
				files = append(files, f)
			}
		}
	})
	if len(files) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var gcsToken string
	var gcsErr error
	names := map[string]int{}
	for i := range files {
		f := &files[i]
		if f.GCS && gcsToken == "" && gcsErr == nil {
			gcsToken, gcsErr = dl.GCSToken(ctx)
		}
		if f.GCS && gcsErr != nil {
			f.Err = gcsErr
			continue
		}
		names[f.Name]++
		if n := names[f.Name]; n > 1 {
			f.Name = fmt.Sprintf("%d-%s", n, f.Name)
		}
		f.Path = filepath.Join(dir, f.Name)
		token := ""
		if f.GCS {
			token = gcsToken
		}
		if f.Err = dl.fetch(ctx, f.Download, f.Path, token); f.Err != nil {
			f.Path = ""
			continue
		}
		d.each(func(body, _ *string) { *body = strings.ReplaceAll(*body, f.URL, f.Path) })
	}
	d.Dir, d.Files = dir, files
	return nil
}

func (dl Downloader) fetch(ctx context.Context, from, to, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, from, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := dl.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if token != "" &&
		(resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
		return fmt.Errorf(
			"%s from Google Cloud Storage; run: gcloud auth login with an account that can read the bucket",
			resp.Status,
		)
	}
	if resp.StatusCode >= 300 {
		return errors.New(resp.Status)
	}
	if resp.ContentLength > maxAttachment {
		return fmt.Errorf(
			"skipped: %d bytes exceeds the %d byte limit",
			resp.ContentLength,
			maxAttachment,
		)
	}
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(resp.Body, maxAttachment))
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return err
}
