// Command adapter-vercel implements the filesystem-producing part of the Next.js adapter.
// Its input is a versioned snapshot of the public adapter hook, never application code.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

type object = map[string]any

type request struct {
	Version     int    `json:"version"`
	Routing     object `json:"routing"`
	Config      object `json:"config"`
	ConfigJSON  string `json:"configJSON"`
	Outputs     object `json:"outputs"`
	BuildID     string `json:"buildId"`
	DistDir     string `json:"distDir"`
	RepoRoot    string `json:"repoRoot"`
	ProjectDir  string `json:"projectDir"`
	NextVersion string `json:"nextVersion"`
	// Templates are compiled from the unchanged runtime sources when the package is built.
	TemplatesDir      string              `json:"templatesDir"`
	NextEnvLoaderPath string              `json:"nextEnvLoaderPath,omitempty"`
	NodeRuntime       string              `json:"nodeRuntime"`
	Images            object              `json:"images"`
	FunctionRules     []functionRule      `json:"functionRules"`
	AssetOrder        map[string][]string `json:"assetOrder"`
	WasmOrder         map[string][]string `json:"wasmOrder"`
	EdgeConfigJSON    string              `json:"edgeConfigJSON"`
}

type functionRule struct {
	Pattern string `json:"pattern"`
	Regexp  string `json:"regexp"`
	Options object `json:"options"`
}

func main() {
	defer func() {
		if err := recover(); err != nil {
			fmt.Fprintln(os.Stderr, "Go Vercel adapter:", err)
			os.Exit(1)
		}
	}()
	stopProfile := startProfile()
	defer stopProfile()
	var req request
	profilePhase("decode", func() { check(json.NewDecoder(os.Stdin).Decode(&req)) })
	if req.Version != 1 {
		panic(fmt.Errorf("unsupported adapter protocol %d", req.Version))
	}
	if req.DistDir == "" || req.ProjectDir == "" || req.RepoRoot == "" {
		panic("adapter paths must be provided")
	}
	profilePhase("build", func() { build(req) })
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}
func str(v any) string { s, _ := v.(string); return s }
func obj(v any) object {
	m, _ := v.(map[string]any)
	if m == nil {
		return object{}
	}
	return m
}
func arr(v any) []any {
	a, _ := v.([]any)
	if a == nil {
		return []any{}
	}
	return a
}
func flag(v any) bool { b, _ := v.(bool); return b }
func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	default:
		return true
	}
}
func clone(m object) object {
	n := object{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func merge(ms ...object) object {
	n := object{}
	for _, m := range ms {
		for k, v := range m {
			n[k] = v
		}
	}
	return n
}
func pick(m object, keys ...string) object {
	n := object{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			n[k] = v
		}
	}
	return n
}
func setFrom(dst object, key string, src object, sourceKey string) {
	if v, ok := src[sourceKey]; ok {
		dst[key] = v
	} else {
		delete(dst, key)
	}
}
func jsonText(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	check(e.Encode(v))
	// JSON.stringify emits these two characters literally as well.
	encoded := strings.TrimSuffix(b.String(), "\n")
	var result strings.Builder
	for i := 0; i < len(encoded); {
		if encoded[i] == '\\' && i+1 < len(encoded) {
			if encoded[i+1] == '\\' {
				result.WriteString(encoded[i : i+2])
				i += 2
				continue
			}
			if strings.HasPrefix(encoded[i:], `\u2028`) {
				result.WriteRune('\u2028')
				i += 6
				continue
			}
			if strings.HasPrefix(encoded[i:], `\u2029`) {
				result.WriteRune('\u2029')
				i += 6
				continue
			}
		}
		result.WriteByte(encoded[i])
		i++
	}
	return result.String()
}
func readJSON(p string) object  { var m object; check(json.Unmarshal(read(p), &m)); return m }
func read(p string) []byte      { b, err := os.ReadFile(p); check(err); return b }
func exists(p string) bool      { _, err := os.Stat(p); return err == nil }
func mkdir(p string)            { check(os.MkdirAll(p, 0755)) }
func write(p string, b []byte)  { mkdir(filepath.Dir(p)); check(os.WriteFile(p, b, 0644)) }
func writeJSON(p string, v any) { write(p, []byte(jsonText(v))) }
func writeOnce(p string, b []byte) {
	mkdir(filepath.Dir(p))
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if os.IsExist(err) {
		return
	}
	check(err)
	_, err = f.Write(b)
	closeErr := f.Close()
	check(err)
	check(closeErr)
}
func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	check(err)
	return filepath.ToSlash(r)
}

// Node's path.join preserves an initial prefix even when subsequent components start with /.
func join(parts ...string) string {
	filtered := []string{}
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	s := strings.Join(filtered, "/")
	if s == "" {
		return "."
	}
	trailing := strings.HasSuffix(s, "/")
	s = path.Clean(s)
	if trailing && s != "/" && s != "." {
		s += "/"
	}
	return s
}
func outputPath(root, pathname string) string {
	p := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(pathname, "/")))
	r := rel(root, p)
	if r == ".." || strings.HasPrefix(r, "../") {
		panic(fmt.Errorf("output escapes destination: %q", pathname))
	}
	return p
}
func copyFile(src, dst string) {
	check(os.RemoveAll(dst))
	copyEntry(src, dst)
}
func copyEntry(src, dst string) {
	info, err := os.Lstat(src)
	check(err)
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		check(err)
		mkdir(filepath.Dir(dst))
		check(os.Symlink(target, dst))
		return
	}
	if info.IsDir() {
		mkdir(dst)
		entries, err := os.ReadDir(src)
		check(err)
		for _, e := range entries {
			copyEntry(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()))
		}
		check(os.Chmod(dst, info.Mode().Perm()))
		return
	}
	mkdir(filepath.Dir(dst))
	in, err := os.Open(src)
	check(err)
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	check(err)
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	check(err)
	check(closeErr)
}

// Bound filesystem concurrency independently of the number of outputs. Preserve the first failure.
func parallel(items []any, fn func(object)) {
	if len(items) == 0 {
		return
	}
	jobs := make(chan any)
	var wg sync.WaitGroup
	var once sync.Once
	var failure any
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				func() {
					defer func() {
						if err := recover(); err != nil {
							once.Do(func() { failure = err })
						}
					}()
					fn(obj(item))
				}()
			}
		}()
	}
	for _, item := range items {
		jobs <- item
	}
	close(jobs)
	wg.Wait()
	if failure != nil {
		panic(failure)
	}
}
