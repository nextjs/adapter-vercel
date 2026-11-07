package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func isObject(v any) bool { _, ok := v.(map[string]any); return ok }

func assertGoPathname(value any, description string) {
	s, ok := value.(string)
	valid := ok && strings.HasPrefix(s, "/") && !strings.ContainsAny(s, "\\\x00?#")
	if valid && s != "/" {
		for _, part := range strings.Split(s[1:], "/") {
			if part == "" || part == "." || part == ".." {
				valid = false
			}
		}
	}
	if !valid {
		panic("Invalid Go " + description)
	}
}

func assertGoRouteOutput(o object) {
	if o["type"] != "APP_ROUTE" || o["runtime"] != "go" {
		panic("Go is supported only for App Router route.go handler outputs")
	}
	if str(o["id"]) == "" {
		panic("Go outputs require a route id and sourcePage")
	}
	assertGoPathname(o["pathname"], "output pathname")
	assertGoPathname(o["sourcePage"], "sourcePage")
	if !strings.HasSuffix(str(o["sourcePage"]), "/route") {
		panic("Go sourcePage must identify an App Router route handler")
	}
	if !filepath.IsAbs(str(o["filePath"])) {
		panic("Go filePath must be an absolute path to the precompiled server")
	}
	if !isObject(o["assets"]) || !isObject(o["assetsHashes"]) || !isObject(o["config"]) {
		panic("Go outputs require assets, assetsHashes, and config objects")
	}
	paths, files := map[string]string{}, map[string]bool{}
	for destination, source := range obj(o["assets"]) {
		parts := strings.Split(destination, "/")
		if destination == "" || strings.ContainsAny(destination, "\\\x00") || strings.HasPrefix(destination, "/") || (len(destination) > 1 && destination[1] == ':') {
			panic("Invalid Go asset destination: expected a normalized relative file path")
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." {
				panic("Invalid Go asset destination: expected a normalized relative file path")
			}
		}
		switch strings.ToLower(parts[0]) {
		case "executable", "user-server", ".vc-config.json":
			panic("Reserved Go function asset destination: " + destination)
		}
		key := strings.ToLower(destination)
		if files[key] {
			panic("Conflicting Go asset destinations: " + destination)
		}
		files[key] = true
		for i := 1; i <= len(parts); i++ {
			prefix := strings.Join(parts[:i], "/")
			portable := strings.ToLower(prefix)
			if previous, ok := paths[portable]; ok && previous != prefix {
				panic("Conflicting Go asset destinations: " + destination)
			}
			paths[portable] = prefix
		}
		if !filepath.IsAbs(str(source)) {
			panic("Go asset " + destination + " requires an absolute source path")
		}
	}
	for name := range files {
		parts := strings.Split(name, "/")
		for i := 1; i < len(parts); i++ {
			if files[strings.Join(parts[:i], "/")] {
				panic("Conflicting Go asset destinations: " + name)
			}
		}
	}
}

func collectGoRouteOutputs(outputs object) []any {
	result := []any{}
	ids := map[string]bool{}
	for _, kind := range []string{"appRoutes", "appPages", "pages", "pagesApi", "staticFiles", "middleware"} {
		entries := arr(outputs[kind])
		if kind == "middleware" && outputs[kind] != nil {
			entries = []any{outputs[kind]}
		}
		for _, entry := range entries {
			o := obj(entry)
			value, present := o["runtime"]
			if !present || value == "nodejs" || value == "edge" {
				continue
			}
			if value != "go" {
				panic(fmt.Sprintf("Unsupported Next.js adapter output runtime: %v", value))
			}
			if kind != "appRoutes" {
				panic("Go " + kind + " outputs are unsupported; only App Router route.go handlers are supported")
			}
			assertGoRouteOutput(o)
			if ids[str(o["id"])] {
				panic("Duplicate Go output id: " + str(o["id"]))
			}
			ids[str(o["id"])] = true
			result = append(result, o)
		}
	}
	for _, entry := range arr(outputs["prerenders"]) {
		if ids[str(obj(entry)["parentOutputId"])] {
			panic("Go route outputs cannot be prerender parents")
		}
	}
	return result
}

func (a *adapter) goSourceFile(page string) string {
	source := sourceFile(a.ProjectDir, page, []string{"go"}, []string{"app"}, !directory(filepath.Join(a.ProjectDir, "app")), false, false)
	if source == "" || !strings.HasSuffix(source, "/route.go") {
		panic("Could not resolve Go route.go source for " + page)
	}
	return source
}

func goOutputCollision(name string) {
	panic(&os.PathError{Op: "Refusing to replace a non-Go function output", Path: name, Err: os.ErrExist})
}

func existingGoFunction(name string) bool {
	info, err := os.Lstat(name)
	if os.IsNotExist(err) {
		return false
	}
	check(err)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		goOutputCollision(name)
	}
	configPath := filepath.Join(name, ".vc-config.json")
	info, err = os.Lstat(configPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		goOutputCollision(name)
	}
	var previous object
	data, err := os.ReadFile(configPath)
	if err != nil {
		goOutputCollision(name)
	}
	if err := json.Unmarshal(data, &previous); err != nil || previous["runtime"] != "executable" || previous["handler"] != "executable" || previous["runtimeLanguage"] != "go" || obj(previous["framework"])["slug"] != "nextjs" {
		goOutputCollision(name)
	}
	return true
}

func ensureGoFunctionParent(root, name string) {
	check(os.MkdirAll(root, 0755))
	current := root
	parts := strings.Split(rel(root, filepath.Dir(name)), "/")
	for _, part := range append([]string{""}, parts...) {
		if part != "" && part != "." {
			current = filepath.Join(current, part)
			err := os.Mkdir(current, 0755)
			if !os.IsExist(err) {
				check(err)
			}
		}
		info, err := os.Lstat(current)
		check(err)
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			goOutputCollision(name)
		}
	}
}

func preparedGoFiles(value any) object {
	if !isObject(value) || !isObject(obj(value)["files"]) {
		panic("Invalid Go packager response")
	}
	files := obj(obj(value)["files"])
	if len(files) != 2 || files["executable"] == nil || files["user-server"] == nil {
		panic("Go packager must provide executable and user-server files")
	}
	for _, entry := range files {
		file := obj(entry)
		if !filepath.IsAbs(str(file["fsPath"])) || file["mode"] != float64(0755) {
			panic("Go packager files must have absolute paths and mode 0755")
		}
	}
	return files
}

func goRegions(value any) any {
	regions := arr(value)
	if s, ok := value.(string); ok {
		regions = []any{s}
	}
	result := []any{}
	for _, region := range regions {
		if region == "global" {
			panic("Go preferredRegion=\"global\" is unsupported")
		}
		if region == "auto" {
			return nil
		}
	}
	for _, region := range regions {
		if region == "home" {
			for _, r := range strings.Split(os.Getenv("VERCEL_FUNCTION_REGIONS"), ",") {
				if r != "" {
					result = append(result, r)
				}
			}
		} else {
			result = append(result, region)
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func copyRegularFile(source, destination string, mode os.FileMode) {
	info, err := os.Stat(source)
	check(err)
	if !info.Mode().IsRegular() {
		panic("Go asset is not a regular file: " + source)
	}
	check(os.MkdirAll(filepath.Dir(destination), 0755))
	in, err := os.Open(source)
	check(err)
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	check(err)
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	check(err)
	check(closeErr)
	check(os.Chmod(destination, mode))
}

func (a *adapter) goOutputs(outputs []any) {
	paths := map[string]string{}
	for _, entry := range outputs {
		o := obj(entry)
		assertGoRouteOutput(o)
		name := a.normalized(str(o["pathname"])) + ".func"
		key := strings.ToLower(name)
		if previous, ok := paths[key]; ok && previous != name {
			panic("Conflicting Go function output: " + name)
		}
		paths[key] = name
	}
	for _, entry := range outputs {
		o := obj(entry)
		source := a.goSourceFile(str(o["sourcePage"]))
		options := clone(a.functionOptions(source, str(o["pathname"])))
		cfg := obj(o["config"])
		prepared := preparedGoFiles(a.GoFunctions[str(o["id"])])
		if architecture := str(options["architecture"]); architecture != "" && architecture != "x86_64" {
			panic("Go target architecture conflicts with function configuration for " + source)
		}
		functions := filepath.Join(a.outputDir, "functions")
		name := outputPath(functions, a.normalized(str(o["pathname"]))+".func")
		ensureGoFunctionParent(functions, name)
		existingGoFunction(name)
		stage, err := os.MkdirTemp(filepath.Dir(name), ".go-function-")
		check(err)
		func() {
			defer os.RemoveAll(stage)
			for destination, value := range obj(o["assets"]) {
				info, err := os.Stat(str(value))
				check(err)
				copyRegularFile(str(value), outputPath(stage, destination), info.Mode().Perm())
			}
			for destination, value := range prepared {
				file := obj(value)
				copyRegularFile(str(file["fsPath"]), filepath.Join(stage, destination), 0755)
			}
			options["runtime"] = "executable"
			options["handler"] = "executable"
			options["runtimeLanguage"] = "go"
			options["architecture"] = "x86_64"
			options["supportsResponseStreaming"] = true
			if cfg["maxDuration"] != nil {
				options["maxDuration"] = cfg["maxDuration"]
			}
			if options["regions"] == nil {
				if regions := goRegions(cfg["preferredRegion"]); regions != nil {
					options["regions"] = regions
				}
			}
			options["operationType"] = "API"
			options["framework"] = object{"slug": "nextjs", "version": a.NextVersion}
			writeJSON(filepath.Join(stage, ".vc-config.json"), options)
			if existingGoFunction(name) {
				check(os.RemoveAll(name))
			}
			check(os.Rename(stage, name))
		}()
	}
}

func removeGoRouteParams(destination string) string {
	query := strings.IndexByte(destination, '?')
	if query < 0 {
		return destination
	}
	end := len(destination)
	if hash := strings.IndexByte(destination[query:], '#'); hash >= 0 {
		end = query + hash
	}
	parts := strings.Split(destination[query+1:end], "&")
	remaining := []string{}
	for _, part := range parts {
		key := strings.SplitN(part, "=", 2)[0]
		if !strings.HasPrefix(key, "nxtP") && !strings.HasPrefix(key, "nxtI") {
			remaining = append(remaining, part)
		}
	}
	if len(remaining) == len(parts) {
		return destination
	}
	result := destination[:query]
	if len(remaining) > 0 {
		result += "?" + strings.Join(remaining, "&")
	}
	return result + destination[end:]
}
