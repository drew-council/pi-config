package releases

import (
	"testing"
	"time"
)

func TestNext(t *testing.T) {
	now := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	tags := []string{"v2026-09-16.0", "v2026-09-16.2-hotfix", "v2026-09-15.9"}
	if got := Next(tags, now, false); got != "v2026-09-16.3" {
		t.Fatal(got)
	}
	if got := Next(tags, now, true); got != "v2026-09-16.3-hotfix" {
		t.Fatal(got)
	}
}

func TestContains(t *testing.T) {
	if !ContainsStatus("behind") || !ContainsStatus("identical") || ContainsStatus("ahead") {
		t.Fatal("bad mapping")
	}
}
