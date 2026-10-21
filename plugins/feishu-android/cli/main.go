package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/larksuite/cli/cmd"
	"github.com/larksuite/cli/extension/credential"
	"github.com/larksuite/cli/extension/fileio"
)

// 每次调用都是独立子进程；密钥只由标准输入传入，不放进命令行或配置文件。
type request struct {
	Args      []string `json:"args"`
	AppID     string   `json:"appId"`
	Identity  string   `json:"identity"`
	Token     string   `json:"token"`
	Workspace string   `json:"workspace"`
	Stdin     string   `json:"stdin"`
}

type invocationCredentials struct{ request }

func (p invocationCredentials) Name() string { return "familiar-android" }
func (p invocationCredentials) ResolveAccount(ctx context.Context) (*credential.Account, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	support := credential.SupportsUser
	if p.Identity == "bot" {
		support = credential.SupportsBot
	}
	return &credential.Account{AppID: p.AppID, Brand: credential.BrandFeishu, DefaultAs: credential.Identity(p.Identity), SupportedIdentities: support}, nil
}
func (p invocationCredentials) ResolveToken(ctx context.Context, spec credential.TokenSpec) (*credential.Token, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	expected := credential.TokenTypeUAT
	if p.Identity == "bot" {
		expected = credential.TokenTypeTAT
	}
	if p.Token == "" || spec.AppID != p.AppID || spec.Type != expected {
		return nil, &credential.BlockError{Provider: p.Name(), Reason: "手机飞书身份未就绪，请在灵伴中重新连接。"}
	}
	return &credential.Token{Value: p.Token, Source: p.Name()}, nil
}

// 默认密钥链不能退回 Linux 文件密钥；账号生命周期由 Android Keystore 所有者管理。
type noKeychain struct{}

func (noKeychain) Get(string, string) (string, error) {
	return "", errors.New("FAMILIAR_KEYCHAIN_ONLY")
}
func (noKeychain) Set(string, string, string) error { return errors.New("FAMILIAR_KEYCHAIN_ONLY") }
func (noKeychain) Remove(string, string) error      { return errors.New("FAMILIAR_KEYCHAIN_ONLY") }

func decodeRequest(in io.Reader) (request, error) {
	var value request
	data, err := io.ReadAll(io.LimitReader(in, 131073))
	if err != nil {
		return value, errors.New("INPUT_READ_FAILED")
	}
	if len(data) > 131072 {
		return value, errors.New("INPUT_TOO_LARGE")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&value); err != nil {
		return value, errors.New("INPUT_JSON_INVALID")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return value, errors.New("INPUT_TRAILING_DATA")
	}
	if err = validateArgs(value.Args); err != nil {
		return value, err
	}
	if value.Identity != "user" && value.Identity != "bot" {
		return value, errors.New("INVALID_IDENTITY")
	}
	if value.AppID != "" && !appIDPattern.MatchString(value.AppID) {
		return value, errors.New("INVALID_APP_ID")
	}
	if len(value.Token) > 16384 || strings.ContainsAny(value.Token, "\r\n\x00") || value.Token != "" && value.AppID == "" {
		return value, errors.New("INVALID_TOKEN")
	}
	return value, nil
}

func main() {
	value, err := decodeRequest(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(2)
	}
	workspace, err := newWorkspace(value.Workspace)
	if err != nil {
		fmt.Fprintln(os.Stderr, "INVALID_WORKSPACE")
		os.Exit(2)
	}
	defer workspace.Close()
	credential.Register(invocationCredentials{value})
	fileio.Register(workspace)
	skills, err := fs.Sub(distributionContent, "skills")
	if err != nil {
		panic(err)
	}
	guidance, err := fs.Sub(distributionContent, "affordance")
	if err != nil {
		panic(err)
	}
	cmd.SetEmbeddedSkillContent(skills)
	cmd.SetEmbeddedAffordanceContent(guidance)
	os.Args = append([]string{"lark-cli"}, value.Args...)
	if !localCommand(value.Args) {
		os.Args = append(os.Args, "--as", value.Identity)
	}
	code := cmd.ExecuteWithOptions(cmd.WithIO(strings.NewReader(value.Stdin), os.Stdout, os.Stderr), cmd.WithKeychain(noKeychain{}), cmd.HideProfile(true))
	workspace.Close()
	os.Exit(code)
}
