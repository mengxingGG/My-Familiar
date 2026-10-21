package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf16"
)

// TypeScript 与 Go 读取同一组输入，不将中文误作字节、表情误作单个码位。
func TestOfficeArgumentUnicodeBoundary(t *testing.T) {
	data, err := os.ReadFile("policy_cases_test.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name       string `json:"name"`
		Unit       string `json:"unit"`
		Repeat     int    `json:"repeat"`
		Suffix     string `json:"suffix"`
		UTF16Units int    `json:"utf16Units"`
		Accepted   bool   `json:"accepted"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			value := strings.Repeat(c.Unit, c.Repeat) + c.Suffix
			if got := len(utf16.Encode([]rune(value))); got != c.UTF16Units {
				t.Fatalf("fixture units: got %d want %d", got, c.UTF16Units)
			}
			err := validateArgs([]string{"docs", "+create", "--content", value})
			if (err == nil) != c.Accepted {
				t.Fatalf("UTF-16 units=%d UTF-8 bytes=%d accepted=%v want=%v", c.UTF16Units, len(value), err == nil, c.Accepted)
			}
		})
	}
}
