package output

import (
	"bytes"
	"strings"
	"testing"
)

func TestRender(t *testing.T) {
	rows := []Row{R("id", 1, "name", "run")}
	var b bytes.Buffer
	if err := Render(&b, rows, false); err != nil || b.String() != "1\trun\n" {
		t.Fatalf("%q %v", b.String(), err)
	}
	b.Reset()
	if err := Render(&b, rows, true); err != nil || !strings.Contains(b.String(), `"name": "run"`) {
		t.Fatalf("%q %v", b.String(), err)
	}
}
