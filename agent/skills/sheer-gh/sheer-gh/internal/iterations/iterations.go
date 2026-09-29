package iterations

import (
	"fmt"
	"sort"
	"time"
)

type Iteration struct {
	ID, Title, StartDate string
	Duration             int
	Completed            bool
	State                string
}

func Annotate(items []Iteration, now time.Time) []Iteration {
	out := append([]Iteration(nil), items...)
	for i := range out {
		start, _ := time.Parse("2006-01-02", out[i].StartDate)
		end := start.Add(time.Duration(out[i].Duration) * 24 * time.Hour)
		switch {
		case out[i].Completed:
			out[i].State = "completed"
		case !now.Before(start) && now.Before(end):
			out[i].State = "current"
		default:
			out[i].State = "upcoming"
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartDate < out[j].StartDate })
	return out
}

func Resolve(items []Iteration, which string) (Iteration, error) {
	if which == "" {
		which = "current"
	}
	for _, it := range items {
		if it.Title == which || it.State == which {
			return it, nil
		}
	}
	return Iteration{}, fmt.Errorf("no sprint matches %q", which)
}
