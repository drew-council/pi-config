package refs

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var shaRE = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

func Number(value string) (int, error) {
	value = strings.TrimPrefix(value, "#")
	if i := strings.LastIndex(value, "/"); i >= 0 {
		value = value[i+1:]
	}
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("not an issue or PR number: %s", value)
	}
	return n, nil
}

func RunID(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("not a run id: %s", value)
	}
	return n, nil
}

func IsRunID(value string) bool {
	return len(value) >= 9 &&
		strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) < 0
}
func IsSHA(value string) bool { return shaRE.MatchString(value) }
