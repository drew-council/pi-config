package cilogs

import (
	"strings"
	"testing"
)

func TestErrors(t *testing.T) {
	log := "job\tstep\t2026-01-01T00:00:00Z ok\njob\tstep\t2026-01-01T00:00:01Z ##[error]broken\njob\tstep\t2026-01-01T00:00:02Z ##[error]broken\n"
	got := Errors(strings.NewReader(log))
	if len(got) != 1 || got[0] != "##[error]broken" {
		t.Fatalf("got %#v", got)
	}
}
