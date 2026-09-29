package iterations

import (
	"testing"
	"time"
)

func TestAnnotateResolve(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	items := Annotate(
		[]Iteration{
			{ID: "old", StartDate: "2026-08-01", Duration: 14, Completed: true},
			{ID: "current", Title: "Sprint 1", StartDate: "2026-09-10", Duration: 14},
			{ID: "next", StartDate: "2026-09-24", Duration: 14},
		},
		now,
	)
	if items[1].State != "current" || items[2].State != "upcoming" {
		t.Fatalf("states %#v", items)
	}
	got, err := Resolve(items, "current")
	if err != nil || got.ID != "current" {
		t.Fatalf("got %#v %v", got, err)
	}
}
