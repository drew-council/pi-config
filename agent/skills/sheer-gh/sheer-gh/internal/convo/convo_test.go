package convo

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// toServer sends every request to the test server, whatever host it names.
type toServer struct{ target *url.URL }

func (t toServer) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme, req.URL.Host = t.target.Scheme, t.target.Host
	return http.DefaultTransport.RoundTrip(req)
}

const (
	assetURL  = "https://github.com/user-attachments/assets/59b15375-fd1c-43a5-87ec-72a83cd27086"
	consoleGC = "https://console.cloud.google.com/storage/browser/_details/document.sheerhealth.com/admin-tmp/3dd3/Screenshot%202026-09-16%20at%207.26.30%E2%80%AFAM.png"
)

func TestFind(t *testing.T) {
	body := "<img src=\"" + assetURL + "\" />\n- " + consoleGC + "\n" +
		"https://storage.googleapis.com/storage/v1/b/x/o/y (from a log)\n" +
		"https://storage.cloud.google.com/bucket/dir/trace.zip."
	html := `<img src="https://private-user-images.githubusercontent.com/2655/652536904-59b15375-fd1c-43a5-87ec-72a83cd27086.png?jwt=abc">`
	files := Find(body, html)
	if len(files) != 3 {
		t.Fatalf("got %d files: %+v", len(files), files)
	}
	if files[0].URL != assetURL || files[0].Name != "59b15375-fd1c-43a5-87ec-72a83cd27086.png" ||
		!strings.HasSuffix(files[0].Download, "?jwt=abc") {
		t.Errorf("github: %+v", files[0])
	}
	want := "https://storage.googleapis.com/storage/v1/b/document.sheerhealth.com/o/admin-tmp%2F3dd3%2FScreenshot%202026-09-16%20at%207.26.30%E2%80%AFAM.png?alt=media"
	if files[1].Download != want ||
		files[1].Name != "Screenshot 2026-09-16 at 7.26.30 AM.png" {
		t.Errorf("gcs: %+v", files[1])
	}
	if files[2].Name != "trace.zip" ||
		!strings.HasSuffix(files[2].Download, "dir%2Ftrace.zip?alt=media") {
		t.Errorf("gcs trailing dot: %+v", files[2])
	}
}

func TestAttachAndMarkdown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/b/") && r.Header.Get("Authorization") != "Bearer gcs" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, "bytes")
	}))
	defer server.Close()
	doc := &Doc{
		Slug:   "issue-1",
		Title:  "#1 Title",
		Header: []string{"state: OPEN"},
		Body:   "see " + assetURL + " and " + consoleGC,
		HTML:   `<img src="https://private-user-images.githubusercontent.com/1/2-59b15375-fd1c-43a5-87ec-72a83cd27086.png?jwt=x">`,
		Posts: []Post{
			{Kind: "comment", ID: "9", Author: "b", Time: "2026-09-17T20:22:34Z", Body: "later"},
			{
				Kind:   "comment",
				ID:     "8",
				Author: "a",
				Time:   "2026-09-16T20:22:34Z",
				Body:   "again " + assetURL,
				Posts: []Post{
					{Kind: "reply", Author: "c", Time: "2026-09-16T21:00:00Z", Body: "ok"},
				},
			},
		},
	}
	dir := t.TempDir()
	target, _ := url.Parse(server.URL)
	dl := Downloader{
		HTTP:     &http.Client{Transport: toServer{target}},
		GCSToken: func(context.Context) (string, error) { return "gcs", nil },
	}
	if err := doc.Attach(context.Background(), dir, dl); err != nil {
		t.Fatal(err)
	}
	doc.Sort()
	md := doc.Markdown()
	local := filepath.Join(dir, "59b15375-fd1c-43a5-87ec-72a83cd27086.png")
	gcs := filepath.Join(dir, "Screenshot 2026-09-16 at 7.26.30 AM.png")
	for _, name := range []string{local, gcs} {
		if data, err := os.ReadFile(name); err != nil || string(data) != "bytes" {
			t.Fatalf("download: %q %v", data, err)
		}
	}
	if !strings.Contains(md, "and "+gcs+"\n") || !strings.Contains(md, gcs+"  <-  "+consoleGC) {
		t.Errorf("gcs link not rewritten:\n%s", md)
	}
	for _, want := range []string{
		"# #1 Title\n\nstate: OPEN\n\nsee " + local,
		"## comment 8 @a 2026-09-16\n\nagain " + local,
		"### reply @c 2026-09-16\n\nok",
		"## comment 9 @b 2026-09-17",
		"attachments in " + dir + ":\n  " + local + "  <-  " + assetURL,
	} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
	if strings.Index(md, "comment 8") > strings.Index(md, "comment 9") {
		t.Error("posts not sorted by time")
	}
	err := dl.fetch(context.Background(), server.URL+"/b/x/o/y", filepath.Join(dir, "y"), "bad")
	if err == nil || !strings.Contains(err.Error(), "gcloud auth login") {
		t.Errorf("gcs auth hint: %v", err)
	}
}
