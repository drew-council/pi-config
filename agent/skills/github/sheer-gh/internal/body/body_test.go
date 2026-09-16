package body

import (
	"strings"
	"testing"
)

func TestReadAndAttribution(t *testing.T) {
	got, err := Read("hello", "", ".", strings.NewReader(""))
	if err != nil || got != "hello" {
		t.Fatalf("got %q %v", got, err)
	}
	got, err = Read("", "-", ".", strings.NewReader("stdin"))
	if err != nil || got != "stdin" {
		t.Fatalf("got %q %v", got, err)
	}
	want := "> _Written by bot on behalf of @drew._\n\nhello"
	if got := Attribution(" hello ", "bot", "drew"); got != want {
		t.Fatalf("got %q", got)
	}
}
