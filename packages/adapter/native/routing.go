package main

import "strings"

func escapeRegexp(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`|\{}()[]^$+*?.-`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
func redirectStatus(v any) bool {
	switch v {
	case float64(301), float64(302), float64(303), float64(307), float64(308):
		return true
	}
	return false
}
func rewriteRoutes(routing object, phase string, segments bool) []any {
	out := []any{}
	for _, v := range arr(routing[phase]) {
		r := obj(v)
		if !truth(r["destination"]) || redirectStatus(r["status"]) {
			continue
		}
		n := pick(r, "has", "missing")
		n["src"] = r["sourceRegex"]
		n["dest"] = r["destination"]
		if phase == "beforeFiles" {
			n["continue"] = true
			n["override"] = true
		} else {
			n["check"] = true
		}
		if segments {
			rewriteHeaders(n, phase == "afterFiles", true)
		}
		out = append(out, n)
	}
	return out
}
func rewriteHeaders(r object, after, segments bool) {
	src, dest := str(r["src"]), str(r["dest"])
	if src == "" || dest == "" {
		return
	}
	external := strings.HasPrefix(dest, "http://") || strings.HasPrefix(dest, "https://")
	pathname, query := "", ""
	if !external {
		pathname = dest
		if i := strings.IndexByte(pathname, '?'); i >= 0 {
			query = pathname[i+1:]
			pathname = pathname[:i]
			query = strings.SplitN(query, "#", 2)[0]
			parts := []string{}
			for _, part := range strings.Split(query, "&") {
				key := strings.SplitN(part, "=", 2)[0]
				if !strings.HasPrefix(key, "nxtP") && !strings.HasPrefix(key, "nxtI") {
					parts = append(parts, part)
				}
			}
			query = strings.Join(parts, "&")
		} else {
			pathname = strings.SplitN(pathname, "#", 2)[0]
		}
	}
	if after {
		// The Next.js routing contract terminates rewrite regexes with this suffix.
		for _, suffix := range []string{`\/?(?:\/)?$`, `\/(?:\/)?$`, `(?:\/)?$`} {
			if strings.HasSuffix(src, suffix) {
				rsc := `\.rsc`
				if segments {
					rsc += `|\.segments/.+\.segment\.rsc`
				}
				src = strings.TrimSuffix(src, suffix) + `(?:/)?(?<rscsuff>` + rsc + `)?`
				break
			}
		}
		r["src"] = src
		if i := strings.IndexByte(dest, '?'); i >= 0 {
			r["dest"] = dest[:i] + "$rscsuff" + dest[i:]
		} else {
			r["dest"] = dest + "$rscsuff"
		}
	}
	if external || pathname == "" && query == "" {
		return
	}
	headers := clone(obj(r["headers"]))
	if pathname != "" {
		headers["x-nextjs-rewritten-path"] = pathname
	}
	if query != "" {
		headers["x-nextjs-rewritten-query"] = query
	}
	r["headers"] = headers
}
func userRoutes(routing object) (priority, redirects, headers, onMatch []any) {
	priority = []any{}
	redirects = []any{}
	headers = []any{}
	onMatch = []any{}
	for _, phase := range []string{"beforeMiddleware", "beforeFiles"} {
		for _, v := range arr(routing[phase]) {
			r := obj(v)
			if redirectStatus(r["status"]) {
				n := pick(r, "headers", "status", "has", "missing")
				n["src"] = r["sourceRegex"]
				if truth(r["priority"]) {
					n["continue"] = true
					priority = append(priority, n)
				} else {
					redirects = append(redirects, n)
				}
			} else if truth(r["headers"]) && !truth(r["destination"]) {
				n := pick(r, "headers", "has", "missing")
				n["src"] = r["sourceRegex"]
				n["continue"] = true
				if truth(r["priority"]) {
					n["important"] = true
				}
				headers = append(headers, n)
			}
		}
	}
	for _, v := range arr(routing["onMatch"]) {
		r := obj(v)
		n := pick(r, "headers", "has", "missing")
		n["src"] = r["sourceRegex"]
		if truth(r["destination"]) {
			n["dest"] = r["destination"]
		}
		n["continue"] = true
		n["important"] = true
		onMatch = append(onMatch, n)
	}
	return
}
func dataRoutes(config object, buildID string, enabled, override, normalize bool) []any {
	if !enabled {
		return []any{}
	}
	base := str(config["basePath"])
	slash := ""
	if truth(config["trailingSlash"]) {
		slash = "/"
	}
	has := []any{object{"type": "header", "key": "x-nextjs-data"}}
	out := []any{}
	if normalize {
		out = append(out, object{"src": join("/", base, "/(?!_next/data(?:/|$))(.*)"), "has": has, "transforms": []any{object{"type": "request.headers", "op": "delete", "target": object{"key": "x-nextjs-data"}}}, "continue": true}, object{"src": join("/", base, "/_next/data/(.*)"), "missing": has, "transforms": []any{object{"type": "request.headers", "op": "append", "target": object{"key": "x-nextjs-data"}, "args": "1"}}, "continue": true})
		for _, r := range []object{{"src": "^" + join("/", base, "/_next/data/", escapeDataBuildID(buildID), "/(.*).json"), "dest": join("/", base, "/$1", slash), "continue": true, "has": has}, {"src": join("^/", base, "/index(?:/)?"), "dest": join("/", base, slash), "continue": true, "has": has}} {
			if override {
				r["override"] = true
			}
			out = append(out, r)
		}
	} else {
		root := "$"
		if base != "" && base != "/" {
			root = base + slash + "$"
		}
		for _, r := range []object{{"src": join("^/", root), "has": has, "dest": join("/", base, "/_next/data/", buildID, "/index.json"), "continue": true}, {"src": join("^/", base, "((?!_next/)(?:.*[^/]|.*))/?$"), "has": has, "dest": join("/", base, "/_next/data/", buildID, "/$1.json"), "continue": true}} {
			if override {
				r["override"] = true
			}
			out = append(out, r)
		}
	}
	return out
}
func escapeDataBuildID(s string) string { return strings.ReplaceAll(escapeRegexp(s), `\-`, "-") }
