package main

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var jsExtension = regexp.MustCompile(`\.(m|c)?js$`)

const jsWhitespaceClass = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// JavaScript's multiline anchors and dot recognize four line terminators.
// Keep the preceding terminator as a capture instead of consuming the next
// line's prefix, so adjacent comments are handled independently.
var inlineMapComment = regexp.MustCompile(`(^|[\r\n\x{2028}\x{2029}])` + jsWhitespaceClass + `*?/[/*][@#]` + jsWhitespaceClass + `+?sourceMappingURL=data:(?:((?:application|text)/json)(?:;charset=[^;,]*)?)?(?:;(base64))?,([^\r\n\x{2028}\x{2029}]*)`)
var base64Data = regexp.MustCompile(`^[a-zA-Z0-9+=/]+$`)

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

func stripInlineMaps(source string) string {
	if !strings.Contains(source, "sourceMappingURL=data:") {
		return source
	}
	for _, match := range inlineMapComment.FindAllStringSubmatch(source, -1) {
		if match[3] != "base64" {
			continue
		}
		// Go's Unicode whitespace includes U+0085, which JavaScript preserves.
		// Removing it would turn template-literal data into an apparent map.
		data := strings.Join(strings.FieldsFunc(match[4], isJSWhitespace), "")
		data = strings.ReplaceAll(data, "*/", "")
		if !base64Data.MatchString(data) {
			continue
		}
		// Match the reference's matchAll followed by String.replace for each
		// original match, including repeated identical comment text.
		source = strings.Replace(source, match[0][len(match[1]):], "", 1)
	}
	return source
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
	a.parallel("edge", outputs, func(o object) {
		functionDir := outputPath(filepath.Join(a.outputDir, "functions"), a.normalized(str(o["pathname"]))+".func")
		mkdir(functionDir)
		assets, wasm := a.assets(o), obj(o["wasmAssets"])
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
		writeJSONOnce(filepath.Join(functionDir, ".vc-config.json"), cfg)
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
