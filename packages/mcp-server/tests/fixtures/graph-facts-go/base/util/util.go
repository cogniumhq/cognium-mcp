package util

import "strings"

func Format(s string) string {
	return "hello " + strings.TrimSpace(s)
}

func neverCalled(n int) int {
	return n * 2
}
