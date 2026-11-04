package main

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var jsExtension = regexp.MustCompile(`\.(m|c)?js$`)
var inlineMapComment = regexp.MustCompile(`(?m)^\s*?/[/*][@#]\s+?sourceMappingURL=data:(?:((?:application|text)/json)(?:;charset=[^;,]*)?)?(?:;(base64))?,([^\n]*)$`)
var base64Data = regexp.MustCompile(`^[a-zA-Z0-9+=/]+$`)

func stripInlineMaps(source string) string {
	return inlineMapComment.ReplaceAllStringFunc(source, func(comment string) string {
		m := inlineMapComment.FindStringSubmatch(comment)
		if len(m) < 4 || m[2] != "base64" {
			return comment
		}
		data := strings.Join(strings.Fields(m[3]), "")
		data = strings.ReplaceAll(data, "*/", "")
		if !base64Data.MatchString(data) {
			return comment
		}
		return ""
	})
}
func orderedKeys(m object, keys []string) []string {
	if keys != nil {
		return keys
	}
	keys = []string{}
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (a *adapter) edgeOutputs(outputs []any) {
	parallel(outputs, func(o object) {
		functionDir := outputPath(filepath.Join(a.outputDir, "functions"), a.normalized(str(o["pathname"]))+".func")
		mkdir(functionDir)
		assets, wasm := obj(o["assets"]), obj(o["wasmAssets"])
		files := object{}
		nonJS := []any{}
		chunks := []string{}
		for _, name := range orderedKeys(assets, a.AssetOrder[str(o["id"])]) {
			p := str(assets[name])
			if jsExtension.MatchString(p) {
				files[name] = rel(a.RepoRoot, p)
				chunks = append(chunks, p)
			} else {
				files["assets/"+name] = rel(a.RepoRoot, p)
				nonJS = append(nonJS, object{"name": name, "path": "assets/" + name})
			}
		}
		imports := []string{}
		for _, name := range orderedKeys(wasm, a.WasmOrder[str(o["id"])]) {
			files["wasm/"+name+".wasm"] = rel(a.RepoRoot, str(wasm[name]))
			if strings.HasPrefix(name, "wasm_") {
				imports = append(imports, "const "+name+" = require("+jsonText("/wasm/"+name+".wasm")+");")
			}
		}
		file := str(o["filePath"])
		files[rel(a.ProjectDir, file)] = rel(a.RepoRoot, file)
		chunks = append(chunks, file)
		name := strings.TrimPrefix(strings.Replace(strings.TrimSuffix(str(o["id"]), ".rsc"), "_middleware", "middleware", 1), "/")
		edgeConfig := a.EdgeConfigJSON
		if edgeConfig == "" {
			edgeConfig = jsonText(pick(a.Config, "basePath", "i18n"))
		}
		params := `{"name":` + jsonText(name) + `,"staticRoutes":[],"dynamicRoutes":[],"nextConfig":` + edgeConfig + `}`
		var source strings.Builder
		source.WriteString("\n  ")
		source.WriteString(strings.Join(imports, "\n"))
		source.WriteString("\n  globalThis._ENTRIES = {};")
		for _, p := range chunks {
			source.WriteString("\n/**/;")
			source.WriteString(stripInlineMaps(string(read(p))))
		}
		template := string(read(filepath.Join(a.TemplatesDir, "edge-function.template.js")))
		source.WriteString(";\n  export default (function () {\n    const module = { exports: {}, loaded: false };\n    const fn = (function(module,exports) {")
		source.WriteString(template)
		source.WriteString("\n});\n    fn(module, module.exports);\n    return module.exports;\n  }).call({}).default(\n    ")
		source.WriteString(params)
		source.WriteString("\n  )")
		handler := join(rel(a.RepoRoot, a.ProjectDir), "index.js")
		writeOnce(outputPath(functionDir, handler), []byte(source.String()))
		cfg := object{"runtime": "edge", "name": name, "entrypoint": handler, "filePathMap": files, "assets": nonJS, "deploymentTarget": "v8-worker", "environment": object{}, "framework": object{"slug": "nextjs", "version": a.NextVersion}}
		outputConfig := obj(o["config"])
		if outputConfig["env"] != nil {
			cfg["environment"] = outputConfig["env"]
		}
		if truth(outputConfig["preferredRegion"]) {
			if regions := normalizeRegions(outputConfig["preferredRegion"]); regions != nil {
				cfg["regions"] = regions
			}
		}
		writeOnce(filepath.Join(functionDir, ".vc-config.json"), []byte(jsonText(cfg)))
	})
}
func normalizeRegions(value any) any {
	regions := arr(value)
	if s, ok := value.(string); ok {
		regions = []any{s}
	}
	out := []any{}
	for _, r := range regions {
		switch r {
		case "home":
			if home := envOr("VERCEL_FUNCTION_REGIONS", ""); home != "" {
				for _, v := range strings.Split(home, ",") {
					out = append(out, v)
				}
			}
		case "global":
			return "all"
		case "auto":
			return "auto"
		default:
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
