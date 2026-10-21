package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/larksuite/cli/extension/credential"
	"github.com/larksuite/cli/extension/fileio"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfficeCommandPolicy(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"calendar", "+create", "--summary", "会议"}, {"docs", "+fetch", "--doc", "abc"}, {"schema", "calendar", "calendars", "list"}, {"skills", "read", "lark-calendar/references/lark-calendar-schedule-meeting.md"}, {"contact", "+search-user"}, {"mail", "user_mailbox.messages", "get"}} {
		if err := validateArgs(args); err != nil {
			t.Fatalf("allowed %v: %v", args, err)
		}
	}
	for _, args := range [][]string{nil, {"auth", "login"}, {"config", "show"}, {"api", "GET", "/"}, {"event", "start"}, {"calendar", "--as", "user"}, {"docs", "--profile=other"}, {"docs", "--app-secret=x"}, {"docs", "--endpoint", "https://example.com"}, {"contact", "users", "delete"}, {"mail", "user_mailboxes", "delete"}, {"mail", "+security-reset"}, {"skills", "read", "lark-calendar/../../secret"}, {"skills", "install"}, {"docs", "\x00"}} {
		if err := validateArgs(args); err == nil {
			t.Fatalf("accepted forbidden %v", args)
		}
	}
	if pureHelp([]string{"docs", "+create", "--content", "--help"}) {
		t.Fatal("content treated as help")
	}
}

func TestInputAndCredentials(t *testing.T) {
	base := request{Args: []string{"calendar", "--help"}, AppID: "cli_0123456789abcdef", Identity: "bot", Token: "fixture-only"}
	data, _ := json.Marshal(base)
	if _, err := decodeRequest(strings.NewReader(string(data))); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{string(data) + "{}", `{"args":["--help"],"identity":"root"}`, `{"args":["--help"],"identity":"bot","extra":true}`, strings.Repeat(" ", 131073)} {
		if _, err := decodeRequest(strings.NewReader(bad)); err == nil {
			t.Fatal("accepted invalid input")
		}
	}
	p := invocationCredentials{base}
	account, err := p.ResolveAccount(context.Background())
	if err != nil || account.AppSecret != "" || account.DefaultAs != credential.IdentityBot {
		t.Fatal(account, err)
	}
	token, err := p.ResolveToken(context.Background(), credential.TokenSpec{AppID: base.AppID, Type: credential.TokenTypeTAT})
	if err != nil || token.Value != base.Token {
		t.Fatal("token resolution failed")
	}
	for _, spec := range []credential.TokenSpec{{AppID: "different", Type: credential.TokenTypeTAT}, {AppID: base.AppID, Type: credential.TokenTypeUAT}} {
		token, err = p.ResolveToken(context.Background(), spec)
		var blocked *credential.BlockError
		if token != nil || !errors.As(err, &blocked) {
			t.Fatal("credential fallback allowed")
		}
	}
	p.Token = ""
	if token, err = p.ResolveToken(context.Background(), credential.TokenSpec{AppID: base.AppID, Type: credential.TokenTypeTAT}); token != nil || err == nil {
		t.Fatal("missing credential fallback")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = p.ResolveToken(ctx, credential.TokenSpec{}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost")
	}
}

func TestInputUnicodeArgumentTransport(t *testing.T) {
	for _, value := range []string{strings.Repeat("中", 32000), strings.Repeat("😀", 16000), strings.Repeat("a😀中", 8000)} {
		input := request{Args: []string{"docs", "+create", "--content", value}, Identity: "user"}
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		if len(data) > 131072 {
			t.Fatal("fixture exceeded the transport envelope")
		}
		got, err := decodeRequest(strings.NewReader(string(data)))
		if err != nil {
			t.Fatal(err)
		}
		if got.Args[3] != value {
			t.Fatal("Unicode argument changed during request decoding")
		}
	}
	// 每个参数独立合法，合起来的实际 UTF-8 请求仍然必须拒绝。
	value := strings.Repeat("中", 32000)
	data, err := json.Marshal(request{Args: []string{"docs", "+create", "--title", value, "--content", value}, Identity: "user"})
	if err != nil {
		t.Fatal(err)
	}
	if len(data) <= 131072 {
		t.Fatal("fixture did not exceed the transport envelope")
	}
	if _, err = decodeRequest(strings.NewReader(string(data))); err == nil || err.Error() != "INPUT_TOO_LARGE" {
		t.Fatalf("expected byte envelope rejection, got %v", err)
	}
}

func TestWorkspaceConfinementAndCommit(t *testing.T) {
	root := t.TempDir()
	w, err := newWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for _, path := range []string{"../secret", filepath.Join(filepath.Dir(root), "secret"), ""} {
		if _, err = w.Open(path); err == nil {
			t.Fatal("opened outside workspace")
		}
		if _, err = w.Save(path, fileio.SaveOptions{}, strings.NewReader("bad")); err == nil {
			t.Fatal("wrote outside workspace")
		}
	}
	if _, err = w.Save("notes/a.txt", fileio.SaveOptions{}, strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	if _, err = w.SaveExclusive("notes/a.txt", fileio.SaveOptions{}, strings.NewReader("second")); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("exclusive overwrite: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "notes/a.txt")); string(got) != "first" {
		t.Fatal("existing file changed")
	}
	if _, err = w.SaveExclusive("notes/b.txt", fileio.SaveOptions{}, strings.NewReader("new")); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Save("notes/a.txt", fileio.SaveOptions{}, strings.NewReader("updated")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "notes/a.txt")); string(got) != "updated" {
		t.Fatal("rename did not commit")
	}
	if _, err = w.Save("notes/a.txt", fileio.SaveOptions{ContentLength: fileLimit + 1}, strings.NewReader("bad")); err == nil {
		t.Fatal("oversized declaration accepted")
	}
	if err = w.RemoveWorkspaceEntry("notes"); err == nil {
		t.Fatal("recursive remove allowed")
	}
	if err = w.RemoveWorkspaceEntry("."); err == nil {
		t.Fatal("workspace root removed")
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "notes")); len(entries) != 2 {
		t.Fatal("temporary file leaked")
	}
}

func TestWorkspaceSymlinkCannotEscape(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skip("host cannot create symlink: " + err.Error())
	}
	w, err := newWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err = w.Open("escape/secret"); err == nil {
		t.Fatal("symlink read escaped")
	}
	if _, err = w.ResolvePath("escape/secret"); err == nil {
		t.Fatal("symlink validation escaped")
	}
	if _, err = w.ResolvePath("escape/new/child.txt"); err == nil {
		t.Fatal("symlink parent validation escaped")
	}
	if _, err = w.Save("escape/secret", fileio.SaveOptions{}, strings.NewReader("bad")); err == nil {
		t.Fatal("symlink write escaped")
	}
	if got, _ := os.ReadFile(filepath.Join(outside, "secret")); string(got) != "private" {
		t.Fatal("outside changed")
	}
}
