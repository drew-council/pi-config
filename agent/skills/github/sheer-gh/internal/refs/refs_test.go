package refs

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestNumber(t *testing.T) {
	inputs := []string{"#123", "https://github.com/sheerhealth/sheer/issues/42", "7"}
	want := []int{123, 42, 7}
	got := make([]int, 0, len(inputs))
	for _, input := range inputs {
		number, err := Number(input)
		if err != nil {
			t.Fatalf("Number(%q): %v", input, err)
		}
		got = append(got, number)
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Fatalf("numbers mismatch (-want +got):\n%s", diff)
	}
	if _, err := Number("nope"); err == nil {
		t.Fatal("expected invalid ref error")
	}
}

func TestKinds(t *testing.T) {
	if !IsRunID("123456789") || IsRunID("123") || !IsSHA("abcdef1") {
		t.Fatal("reference classification failed")
	}
}
