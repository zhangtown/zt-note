// Command sycheck 验证 .sy 文件 parse → marshal 的字节级保真，并打印统计。
//
//	go run ./tools/sycheck <目录或文件...>
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"ztnote/internal/siyuan"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("用法: sycheck <目录或 .sy 文件...>")
		os.Exit(2)
	}
	var files []string
	for _, arg := range os.Args[1:] {
		st, err := os.Stat(arg)
		if err != nil {
			fmt.Println("跳过:", arg, err)
			continue
		}
		if st.IsDir() {
			_ = filepath.Walk(arg, func(p string, info os.FileInfo, err error) error {
				if err == nil && !info.IsDir() && strings.HasSuffix(p, ".sy") {
					files = append(files, p)
				}
				return nil
			})
			continue
		}
		files = append(files, arg)
	}
	ok, fail := 0, 0
	var blocks, texts int
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			fmt.Printf("读失败 %s: %v\n", f, err)
			fail++
			continue
		}
		doc, err := siyuan.Parse(raw)
		if err != nil {
			fmt.Printf("解析失败 %s: %v\n", f, err)
			fail++
			continue
		}
		out := doc.Marshal()
		if string(out) != string(raw) {
			fail++
			fmt.Printf("✗ 往返不一致 %s (%d → %d 字节)\n", f, len(raw), len(out))
			// 打印首个差异位置
			n := len(raw)
			if len(out) < n {
				n = len(out)
			}
			for i := 0; i < n; i++ {
				if raw[i] != out[i] {
					lo := i - 60
					if lo < 0 {
						lo = 0
					}
					hi := i + 60
					if hi > n {
						hi = n
					}
					fmt.Printf("   原文: ...%s...\n   输出: ...%s...\n", raw[lo:hi], out[lo:hi])
					break
				}
			}
			continue
		}
		ok++
		blocks += len(doc.Children)
		for _, c := range doc.Children {
			texts += len(c.Text())
		}
	}
	fmt.Printf("往返一致 %d 篇 / 失败 %d 篇（顶层块 %d，正文字符 %d）\n", ok, fail, blocks, texts)
	if fail > 0 {
		os.Exit(1)
	}
}
