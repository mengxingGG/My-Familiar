package main

import (
	"errors"
	"regexp"
	"strings"
)

var appIDPattern = regexp.MustCompile(`^cli_[0-9a-fA-F]{16}$`)
var commandWord = regexp.MustCompile(`^[a-zA-Z0-9_+.-]+$`)
var forbiddenFlag = regexp.MustCompile(`^--(?:as|app|app-id|app-secret|app-secret-stdin|token|access-token|user-access-token|config|profile|credential|credential-provider|plugin|plugins|plugin-dir|endpoint|base-url|domain)(?:=|$)`)
var managementShortcut = regexp.MustCompile(`^\+(?:account|user-(?:create|delete|update)|password|credential|oauth|security|admin|settings)(?:-|$)`)
var skillName = regexp.MustCompile(`^lark-[a-z0-9/._-]+$`)
var officeDomains = strings.Fields("calendar docs drive sheets base bitable task im wiki contact mail vc minutes board markdown approval attendance okr slides apps whiteboard mindnotes note schema skills")

func pureHelp(args []string) bool {
	if len(args) == 0 || (args[len(args)-1] != "--help" && args[len(args)-1] != "-h") {
		return false
	}
	for _, arg := range args[:len(args)-1] {
		if !commandWord.MatchString(arg) || strings.HasPrefix(arg, "-") {
			return false
		}
	}
	return true
}
func localCommand(args []string) bool {
	return pureHelp(args) || args[0] == "schema" || args[0] == "skills"
}
func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// JS String.length 按 UTF-16 单位计数；UTF-8 字节数和 rune 数都不能替代它。
// 直接遍历并在超限时返回，避免为长参数额外分配 UTF-16 数组。
func exceedsUTF16Limit(value string, limit int) bool {
	units := 0
	for _, r := range value {
		units++
		if r > 0xffff {
			units++
		}
		if units > limit {
			return true
		}
	}
	return false
}

// 与桌面办公边界一致；手机入口不能切换身份、覆盖服务地址或管理账号。
func validateArgs(args []string) error {
	deny := errors.New("OFFICE_COMMAND_NOT_ALLOWED")
	if len(args) == 0 || len(args) > 60 {
		return deny
	}
	for _, arg := range args {
		if exceedsUTF16Limit(arg, 32000) || strings.ContainsRune(arg, 0) || forbiddenFlag.MatchString(arg) {
			return deny
		}
	}
	if len(args) == 1 && pureHelp(args) {
		return nil
	}
	if !contains(officeDomains, args[0]) {
		return deny
	}
	if args[0] == "skills" && (len(args) != 3 || args[1] != "read" || !skillName.MatchString(args[2]) || strings.Contains(args[2], "..")) {
		return deny
	}
	if len(args) < 2 || pureHelp(args) {
		return nil
	}
	if managementShortcut.MatchString(args[1]) {
		return deny
	}
	if args[0] == "contact" && !contains([]string{"+get-user", "+search-user", "+search-bot"}, args[1]) && !(len(args) >= 3 && args[1] == "user_profiles" && args[2] == "batch_query") {
		return deny
	}
	if args[0] == "mail" && !strings.HasPrefix(args[1], "+") && !contains(strings.Fields("multi_entity user_mailbox.drafts user_mailbox.event user_mailbox.folders user_mailbox.labels user_mailbox.mail_contacts user_mailbox.message.attachments user_mailbox.messages user_mailbox.rules user_mailbox.sent_messages user_mailbox.template.attachments user_mailbox.templates user_mailbox.threads"), args[1]) && !(len(args) >= 3 && args[1] == "user_mailboxes" && contains([]string{"accessible_mailboxes", "profile", "search"}, args[2])) {
		return deny
	}
	return nil
}
