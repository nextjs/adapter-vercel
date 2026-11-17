package main

import (
	"os"
	"path/filepath"
	"strings"
)

func directory(name string) bool { info, err := os.Stat(name); return err == nil && info.IsDir() }
func usesSrcDirectory(root string) bool {
	return directory(filepath.Join(root, "src/pages")) || directory(filepath.Join(root, "src/app"))
}

func sourceFile(workPath, page string, extensions, types []string, src, extensionless, directoryIndex bool) string {
	if extensions == nil {
		extensions = []string{"js", "jsx", "ts", "tsx"}
	}
	if types == nil {
		types = []string{"pages", "app"}
	}
	if page == "middleware" {
		types = []string{""}
	}
	root := workPath
	if src {
		root = filepath.Join(root, "src")
	}
	for _, typ := range types {
		base := filepath.Join(root, typ, filepath.FromSlash(strings.TrimPrefix(page, "/")))
		if extensionless && exists(base) {
			return rel(workPath, base)
		}
		for _, ext := range extensions {
			candidate := base + "." + ext
			if typ == "app" && base == filepath.Join(root, "app/index") {
				candidate = filepath.Join(root, "app/page") + "." + ext
			}
			if exists(candidate) {
				return rel(workPath, candidate)
			}
		}
		info, err := os.Lstat(base)
		if directoryIndex && err == nil && info.IsDir() {
			names := []string{"index"}
			if typ != "pages" {
				names = []string{"page", "route"}
			}
			for _, ext := range extensions {
				for _, name := range names {
					candidate := filepath.Join(base, name+"."+ext)
					if exists(candidate) {
						return rel(workPath, candidate)
					}
				}
			}
		}
	}
	return ""
}

func stringsFrom(value any) []string {
	if value == nil {
		return nil
	}
	result := []string{}
	for _, item := range arr(value) {
		result = append(result, str(item))
	}
	return result
}
