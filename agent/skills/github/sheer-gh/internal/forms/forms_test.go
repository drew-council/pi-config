package forms

import "testing"

func TestParseAndTemplate(t *testing.T) {
	data := []byte(
		"name: Bug\ntype: Bug\nlabels: ['area/app', debt]\nbody:\n  - type: markdown\n    attributes:\n      label: Ignore\n  - type: textarea\n    attributes:\n      label: What happened?\n  - type: dropdown\n    attributes:\n      label: Severity\n      options: [Low, High]\n",
	)
	f, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Labels) != 2 ||
		f.Template() != "### What happened?\n\n<...>\n\n### Severity\n\n<one of the options below>\n  - Low\n  - High\n\n" {
		t.Fatalf("parsed %#v template %q", f, f.Template())
	}
}
