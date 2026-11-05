package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func (a *adapter) normalized(name string) string {
	base := str(a.Config["basePath"])
	if name == base && base != "/" {
		return join(base, "/index")
	}
	if name == "/" {
		return "/index"
	}
	return name
}

func (a *adapter) staticFiles() {
	outputs := arr(a.Outputs["staticFiles"])
	// Collect map entries serially; copying files is the concurrent work.
	overrides := obj(a.vercelConfig["overrides"])
	immutable := object{}
	for _, v := range outputs {
		o := obj(v)
		name := str(o["pathname"])
		if filepath.Ext(str(o["filePath"])) == ".html" {
			overrides[join("./", name+".html")] = object{"contentType": "text/html; charset=utf-8", "path": join("./", name)}
		}
		if truth(o["immutableHash"]) {
			immutable[name] = o["immutableHash"]
		}
	}
	parallel(outputs, func(o object) {
		suffix := ""
		if filepath.Ext(str(o["filePath"])) == ".html" {
			suffix = ".html"
		}
		copyFile(str(o["filePath"]), outputPath(filepath.Join(a.outputDir, "static"), str(o["pathname"])+suffix))
	})
	write(outputPath(filepath.Join(a.outputDir, "static"), join(str(a.Config["basePath"]), "_next/static/not-found.txt")), []byte("Not Found"))
	if len(immutable) > 0 {
		writeJSON(filepath.Join(a.outputDir, "immutable.json"), object{"version": 1, "hashes": immutable})
	}
}

// Preserve the original insertion order when rewriting a manifest which becomes
// part of a content-addressed function. Go's map encoder otherwise changes its hash.
func deterministicManifest(data []byte) []byte {
	d := json.NewDecoder(bytes.NewReader(data))
	tok, err := d.Token()
	check(err)
	if tok != json.Delim('{') {
		panic("routes manifest must be an object")
	}
	type pair struct {
		key   string
		value json.RawMessage
	}
	pairs := []pair{}
	seen := map[string]bool{}
	for d.More() {
		t, err := d.Token()
		check(err)
		key := t.(string)
		var v json.RawMessage
		check(d.Decode(&v))
		seen[key] = true
		if key == "deploymentId" {
			continue
		}
		if key == "headers" || key == "onMatchHeaders" {
			v = json.RawMessage(`[]`)
		}
		var compact bytes.Buffer
		check(json.Compact(&compact, v))
		pairs = append(pairs, pair{key, compact.Bytes()})
	}
	for _, key := range []string{"headers", "onMatchHeaders"} {
		if !seen[key] {
			pairs = append(pairs, pair{key, json.RawMessage(`[]`)})
		}
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonText(p.key))
		b.WriteByte(':')
		b.Write(p.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

func (a *adapter) fallbackJSON() string {
	var b strings.Builder
	b.WriteByte('{')
	for i, key := range a.fallbackOrder {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonText(key))
		b.WriteByte(':')
		b.WriteString(jsonText(a.fallbacks[key]))
	}
	b.WriteByte('}')
	return b.String()
}

func (a *adapter) handler(middleware bool, envLoader string) []byte {
	name := "node-handler.template.js"
	if middleware {
		name = "middleware-handler.template.js"
	}
	source := string(read(filepath.Join(a.TemplatesDir, name)))
	source = strings.ReplaceAll(source, jsonText("__GO_DIST_DIR__"), jsonText(rel(a.ProjectDir, a.DistDir)))
	source = strings.ReplaceAll(source, jsonText("__GO_FALLBACKS__"), a.fallbackJSON())
	config := a.ConfigJSON
	if config == "" {
		config = jsonText(a.Config)
	}
	source = strings.ReplaceAll(source, jsonText("__GO_CONFIG__"), config)
	source = strings.ReplaceAll(source, jsonText("__GO_ENV_LOADER__"), jsonText(envLoader))
	return []byte(source)
}

func (a *adapter) nodeOutputs(outputs []any, middleware bool) {
	if len(outputs) == 0 {
		return
	}
	manifestPath := filepath.Join(a.DistDir, "routes-manifest-deterministic.json")
	manifest := deterministicManifest(read(filepath.Join(a.DistDir, "routes-manifest.json")))
	manifestHash := hash(manifest)
	write(manifestPath, manifest)
	manifestRel := join(rel(a.RepoRoot, a.DistDir), "routes-manifest.json")
	projectRel := rel(a.RepoRoot, a.ProjectDir)
	envFiles, envHashes := object{}, object{}
	envLoader := ""
	for _, name := range []string{".env", ".env.local", ".env.production", ".env.production.local"} {
		p := filepath.Join(a.ProjectDir, name)
		if info, err := os.Lstat(p); err == nil && info.Mode().IsRegular() {
			envFiles[join(projectRel, name)] = rel(a.RepoRoot, p)
			envHashes[name] = hash(read(p))
		}
	}
	if len(envFiles) > 0 {
		fmt.Fprintln(os.Stderr, "Detected .env file, it is strongly recommended to use Vercel's env handling instead")
		if a.NextEnvLoaderPath == "" {
			panic("Next.js env loader was not resolved by the adapter hook")
		}
		envLoader = rel(a.ProjectDir, a.NextEnvLoaderPath)
		p := rel(a.RepoRoot, a.NextEnvLoaderPath)
		envFiles[p] = p
		envHashes[p] = hash(read(a.NextEnvLoaderPath))
	}
	handler := a.handler(middleware, envLoader)
	handlerRel := join(projectRel, "___next_launcher.cjs")
	handlerHash := hash(handler)
	var pages404, pagesError object
	for _, v := range outputs {
		o := obj(v)
		switch str(o["pathname"]) {
		case join("/", str(a.Config["basePath"]), "/404"):
			pages404 = o
		case join("/", str(a.Config["basePath"]), "/_error"):
			pagesError = o
		}
	}
	notFound := pages404
	if notFound == nil {
		notFound = pagesError
	}
	notFoundHashes := a.hashes(notFound)
	var configs functionConfigs
	parallel(outputs, func(o object) {
		functionDir := outputPath(filepath.Join(a.outputDir, "functions"), a.normalized(str(o["pathname"]))+".func")
		mkdir(functionDir)
		files := a.metadata(o, true)
		hashes := a.metadata(o, false)
		hasHashes := o["assetsHashes"] != nil || o["assetHashMapId"] != nil
		p := rel(a.RepoRoot, str(o["filePath"]))
		files.set(p, p)
		if len(envFiles) > 0 {
			for name, value := range envFiles {
				files.set(name, str(value))
			}
			if hasHashes {
				for name, value := range envHashes {
					hashes.set(name, str(value))
				}
			}
		}
		if o["type"] == "PAGES" {
			if notFound != nil {
				a.eachMap(notFound, "assets", "assetMapId", func(name, source string) {
					files.set(name, a.relative(source))
					if hasHashes {
						hashes.setFrom(name, notFoundHashes)
					}
				})
				p := rel(a.RepoRoot, str(notFound["filePath"]))
				files.set(p, p)
				if hasHashes {
					hashes.setFrom(p, notFoundHashes)
				}
			}
		}
		files.set(manifestRel, rel(a.RepoRoot, manifestPath))
		if hasHashes {
			hashes.set(manifestRel, manifestHash)
		}
		writeOnce(outputPath(functionDir, handlerRel), handler)
		if hasHashes {
			hashes.set(handlerRel, handlerHash)
		}
		source := a.sourceFile(str(o["sourcePage"]))
		options := a.functionOptions(source, str(o["pathname"]))
		outputConfig := obj(o["config"])
		generated := a.generatedOptions(source, str(o["pathname"]))
		options = merge(options, generated)
		duration := options["maxDuration"]
		if v, ok := outputConfig["maxDuration"]; ok {
			duration = v
		}
		if v, ok := generated["maxDuration"]; ok {
			duration = v
		}
		cfg := merge(options, object{"operationType": "API", "framework": object{"slug": "nextjs", "version": a.NextVersion}, "handler": handlerRel, "runtime": a.NodeRuntime, "supportsMultiPayloads": true, "supportsResponseStreaming": true, "experimentalAllowBundling": true, "shouldDisableAutomaticFetchInstrumentation": os.Getenv("VERCEL_TRACING_DISABLE_AUTOMATIC_FETCH_INSTRUMENTATION") == "1", "launcherType": "Nodejs"})
		if duration != nil {
			cfg["maxDuration"] = duration
		}
		if middleware {
			cfg["useWebApi"] = true
		}
		if o["type"] == "APP_PAGE" || o["type"] == "PAGES" {
			cfg["operationType"] = "PAGE"
		}
		if hasHashes {
			configs.write(filepath.Join(functionDir, ".vc-config.json"), cfg, &files, &hashes)
		} else {
			configs.write(filepath.Join(functionDir, ".vc-config.json"), cfg, &files, nil)
		}
	})
}

func (a *adapter) sourceFile(page string) string {
	root, types := a.sourceRoot, a.sourceTypes
	if root == "" {
		root, types = a.ProjectDir, []string{"pages", "app"}
		if exists(filepath.Join(a.ProjectDir, "src/pages")) || exists(filepath.Join(a.ProjectDir, "src/app")) {
			root = filepath.Join(a.ProjectDir, "src")
		}
	}
	if page == "middleware" {
		types = []string{""}
	}
	extensions := arr(a.Config["pageExtensions"])
	if a.Config["pageExtensions"] == nil {
		extensions = []any{"js", "jsx", "ts", "tsx"}
	}
	for _, typ := range types {
		extensionless := filepath.Join(root, typ, strings.TrimPrefix(page, "/"))
		if exists(extensionless) {
			return rel(a.ProjectDir, extensionless)
		}
		for _, ext := range extensions {
			candidate := extensionless + "." + str(ext)
			if typ == "app" && extensionless == filepath.Join(root, "app/index") {
				candidate = filepath.Join(root, "app/page") + "." + str(ext)
			}
			if exists(candidate) {
				return rel(a.ProjectDir, candidate)
			}
		}
		if info, err := os.Lstat(extensionless); err == nil && info.IsDir() {
			names := []string{"index"}
			if typ == "app" {
				names = []string{"page", "route"}
			}
			for _, ext := range extensions {
				for _, name := range names {
					candidate := filepath.Join(extensionless, name+"."+str(ext))
					if exists(candidate) {
						return rel(a.ProjectDir, candidate)
					}
				}
			}
		}
	}
	return ""
}

func (a *adapter) generatedOptions(source, name string) object {
	step := strings.Contains(name, ".well-known/workflow/v1/step") || strings.Contains(name, "api/generated/steps")
	workflow := strings.Contains(name, ".well-known/workflow/v1/flow") || strings.Contains(name, "api/generated/workflows")
	if !step && !workflow {
		return object{}
	}
	parent := filepath.Dir(source)
	if strings.HasSuffix(source, "/route.js") || strings.HasSuffix(source, "/route.ts") {
		parent = filepath.Dir(parent)
	}
	p := filepath.Join(a.ProjectDir, parent, "config.json")
	if !exists(p) {
		return object{}
	}
	cfg := readJSON(p)
	if step && cfg["steps"] != nil {
		return obj(cfg["steps"])
	}
	if workflow {
		return obj(cfg["workflows"])
	}
	return object{}
}

func (a *adapter) functionOptions(source, name string) object {
	// Patterns retain user insertion order through the bridge, as the first match wins.
	for index, rule := range a.FunctionRules {
		matched := source == rule.Pattern
		if !matched {
			var err error
			matched, err = a.functionMatchers[index].MatchString(source)
			check(err)
		}
		if !matched {
			continue
		}
		o := clone(rule.Options)
		return o
	}
	return object{}
}
func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func (a *adapter) prerenders(outputs []any) {
	functions := filepath.Join(a.outputDir, "functions")
	mkdir(functions)
	parallel(outputs, func(o object) {
		name := str(o["pathname"])
		cfg := obj(o["config"])
		fallback := obj(o["fallback"])
		file := str(fallback["filePath"])
		state := str(fallback["postponedState"])
		configPath := outputPath(functions, a.normalized(name)+".prerender-config.json")
		fallbackPath := ""
		if file != "" {
			fallbackPath = outputPath(functions, a.normalized(name)+".prerender-fallback"+filepath.Ext(file))
		} else if state != "" && cfg["allowQuery"] != nil && len(arr(cfg["allowQuery"])) == 0 {
			fallbackPath = outputPath(functions, a.normalized(name)+".prerender-fallback"+path.Ext(name))
		}
		parent := a.parents[str(o["parentOutputId"])]
		if parent == nil {
			panic(fmt.Errorf("failed to find parent node output %v for prerender %s", o["parentOutputId"], name))
		}
		parentDir := outputPath(functions, a.normalized(str(parent["pathname"]))+".func")
		prerenderDir := outputPath(functions, a.normalized(name)+".func")
		if name != str(parent["pathname"]) {
			mkdir(filepath.Dir(prerenderDir))
			err := os.Symlink(rel(filepath.Dir(prerenderDir), parentDir), prerenderDir)
			if !os.IsExist(err) {
				check(err)
			}
		}
		headers := object{}
		if len(arr(a.Outputs["appPages"])) > 0 {
			headers["vary"] = obj(a.Routing["rsc"])["varyHeader"]
		}
		headers = merge(headers, obj(fallback["initialHeaders"]))
		if state != "" && fallbackPath != "" {
			body := []byte(state)
			origin := str(obj(a.Routing["rsc"])["contentTypeHeader"])
			if file != "" {
				body = append(body, read(file)...)
				if path.Ext(name) != ".rsc" {
					origin = "text/html; charset=utf-8"
				}
			}
			writeOnce(fallbackPath, body)
			headers["content-type"] = fmt.Sprintf("application/x-nextjs-pre-render; state-length=%d; origin=%s", len([]byte(state)), jsonText(origin))
		}
		result := pick(cfg, "allowQuery", "allowHeader", "bypassToken")
		result["group"] = o["groupId"]
		result["exposeErrBody"] = true
		result["expiration"] = 1
		if v, ok := fallback["initialRevalidate"]; ok {
			result["expiration"] = v
		}
		setFrom(result, "staleExpiration", fallback, "initialExpiration")
		result["sourcePath"] = parent["pathname"]
		result["passQuery"] = true
		if truth(cfg["partialFallback"]) {
			result["partialFallback"] = cfg["partialFallback"]
		}
		setFrom(result, "experimentalBypassFor", cfg, "bypassFor")
		if compute, ok := o["compute"]; ok {
			metadata := object{"compute": compute}
			setFrom(metadata, "htmlSize", o, "htmlSize")
			result["initialMetadata"] = metadata
		}
		result["initialHeaders"] = headers
		setFrom(result, "initialStatus", fallback, "initialStatus")
		result["fallback"] = nil
		if fallbackPath != "" {
			result["fallback"] = rel(filepath.Dir(configPath), fallbackPath)
		}
		if o["pprChain"] != nil {
			chain := clone(obj(o["pprChain"]))
			chain["outputPath"] = join("./", a.normalized(name))
			result["chain"] = chain
		}
		writeJSONOnce(configPath, result)
		if file != "" && fallbackPath != "" && state == "" {
			copyFile(file, fallbackPath)
		}
		if o["fallback"] != nil && len(headers) == 0 {
			panic("empty initialHeaders")
		}
	})
}
