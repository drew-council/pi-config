package releases

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

func Next(tags []string, now time.Time, hotfix bool) string {
	prefix := "v" + now.Format("2006-01-02") + "."
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(prefix) + `([0-9]+)(?:-hotfix)?$`)
	max := -1
	for _, tag := range tags {
		m := re.FindStringSubmatch(tag)
		if len(m) > 0 {
			n, _ := strconv.Atoi(m[1])
			if n > max {
				max = n
			}
		}
	}
	suffix := ""
	if hotfix {
		suffix = "-hotfix"
	}
	return fmt.Sprintf("%s%d%s", prefix, max+1, suffix)
}
func ContainsStatus(status string) bool { return status == "behind" || status == "identical" }
