package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
)

// 构建脚本从锁定的官方源码复制帮助与 Skill，保持相对引用完整。
//
//go:embed skills affordance
var distributionContent embed.FS

func randomFileID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}
