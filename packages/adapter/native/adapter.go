package main

import (
	"fmt"
	"github.com/dlclark/regexp2"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type adapter struct {
	request
	outputDir                                                    string
	vercelConfig                                                 object
	parents                                                      map[string]object
	fallbacks                                                    object
	fallbackOrder                                                []string
	functionMatchers                                             []*regexp2.Regexp
	relativePaths                                                map[string]string
	encodedBindings                                              []encodedBinding
	sourceRoot                                                   string
	sourceTypes                                                  []string
	hasApp, hasPages, hasMiddleware, has404, has500, hasNotFound bool
}

func build(req request) {
	a := &adapter{request: req, outputDir: filepath.Join(req.DistDir, "output"), vercelConfig: object{"version": 3, "overrides": object{}, "images": req.Images}, parents: map[string]object{}, fallbacks: object{}}
	a.relativePaths = make(map[string]string)
	for _, entry := range req.AssetBindings {
		if filepath.IsAbs(entry[1]) {
			if _, exists := a.relativePaths[entry[1]]; !exists {
				a.relativePaths[entry[1]] = rel(req.RepoRoot, entry[1])
			}
		}
	}
	a.encodeBindings()
	a.sourceRoot = a.ProjectDir
	if exists(filepath.Join(a.ProjectDir, "src/pages")) || exists(filepath.Join(a.ProjectDir, "src/app")) {
		a.sourceRoot = filepath.Join(a.ProjectDir, "src")
	}
	for _, typ := range []string{"pages", "app"} {
		if exists(filepath.Join(a.sourceRoot, typ)) {
			a.sourceTypes = append(a.sourceTypes, typ)
		}
	}
	mkdir(a.outputDir)
	for _, rule := range a.FunctionRules {
		re, err := regexp2.Compile(rule.Regexp, regexp2.ECMAScript)
		check(err)
		re.MatchTimeout = time.Second
		a.functionMatchers = append(a.functionMatchers, re)
	}
	i18n := obj(req.Config["i18n"])
	if i18n["domains"] != nil {
		domains := []any{}
		for _, d := range arr(i18n["domains"]) {
			domain := obj(d)
			value := "/" + str(domain["defaultLocale"])
			if domain["defaultLocale"] == i18n["defaultLocale"] {
				value = ""
			}
			domains = append(domains, object{"domain": domain["domain"], "value": value})
		}
		a.vercelConfig["wildcard"] = domains
	}
	a.hasApp = len(arr(req.Outputs["appPages"]))+len(arr(req.Outputs["appRoutes"])) > 0
	a.hasPages = len(arr(req.Outputs["pages"]))+len(arr(req.Outputs["pagesApi"])) > 0
	a.hasMiddleware = req.Outputs["middleware"] != nil
	profilePhase("public", func() { a.publicFiles() })
	profilePhase("static", func() { a.staticFiles() })
	nodes, edges := []any{}, []any{}
	for _, key := range []string{"appPages", "appRoutes", "pages", "pagesApi", "staticFiles"} {
		for _, v := range arr(req.Outputs[key]) {
			o := obj(v)
			name := str(o["pathname"])
			if strings.HasSuffix(name, "/404") {
				a.hasNotFound = false
				a.has404 = true
			}
			if !a.has404 && strings.HasSuffix(name, "/_not-found") {
				a.hasNotFound = true
			}
			if strings.HasSuffix(name, "/500") {
				a.has500 = true
			}
			switch o["runtime"] {
			case "nodejs":
				a.parents[str(o["id"])] = o
				nodes = append(nodes, o)
			case "edge":
				edges = append(edges, o)
			case nil:
			default:
				panic(fmt.Errorf("unsupported output runtime %v", o["runtime"]))
			}
		}
	}
	for _, v := range arr(req.Outputs["staticFiles"]) {
		name := str(obj(v)["pathname"])
		if strings.HasSuffix(name, "/_not-found") {
			a.hasNotFound = true
		}
		if strings.HasSuffix(name, "/404") {
			a.has404 = true
		}
		if strings.HasSuffix(name, "/500") {
			a.has500 = true
		}
	}
	profilePhase("edge", func() { a.edgeOutputs(edges) })
	base := str(req.Config["basePath"])
	for _, v := range arr(req.Outputs["prerenders"]) {
		o := obj(v)
		name := str(o["pathname"])
		if mode, ok := o["parentFallbackMode"].(bool); ok && !mode && !strings.Contains(name, "_next/data") && !strings.HasSuffix(name, ".rsc") {
			parent := a.parents[str(o["parentOutputId"])]
			if parent == nil {
				panic(fmt.Errorf("missing parent output %v for prerender %s", o["parentOutputId"], name))
			}
			key := strings.TrimPrefix(str(parent["pathname"]), base)
			if a.fallbacks[key] == nil {
				a.fallbackOrder = append(a.fallbackOrder, key)
			}
			a.fallbacks[key] = append(arr(a.fallbacks[key]), strings.TrimPrefix(name, base))
		}
	}
	middlewareRoutes := []any{}
	if a.hasMiddleware {
		middleware := obj(req.Outputs["middleware"])
		switch middleware["runtime"] {
		case "nodejs":
			a.nodeOutputs([]any{middleware}, true)
		case "edge":
			a.edgeOutputs([]any{middleware})
		default:
			panic("unsupported middleware runtime")
		}
		for _, v := range arr(obj(middleware["config"])["matchers"]) {
			m := obj(v)
			r := pick(m, "has", "missing")
			r["src"] = m["sourceRegex"]
			r["continue"] = true
			r["override"] = true
			r["middlewarePath"] = middleware["pathname"]
			raw := []any{}
			if truth(m["source"]) {
				raw = append(raw, m["source"])
			}
			r["middlewareRawSrc"] = raw
			middlewareRoutes = append(middlewareRoutes, r)
		}
	}
	profilePhase("node", func() { a.nodeOutputs(nodes, false) })
	profilePhase("prerenders", func() { a.prerenders(arr(req.Outputs["prerenders"])) })
	profilePhase("routes", func() {
		a.vercelConfig["routes"] = a.routes(middlewareRoutes)
		writeJSON(filepath.Join(a.outputDir, "config.json"), a.vercelConfig)
	})
}

func (a *adapter) routes(middleware []any) []any {
	c, routing := a.Config, a.Routing
	base := str(c["basePath"])
	i18n := obj(c["i18n"])
	hasI18n := c["i18n"] != nil
	trailing := truth(c["trailingSlash"])
	locales := []string{}
	for _, l := range arr(i18n["locales"]) {
		locales = append(locales, escapeRegexp(str(l)))
	}
	localePattern := strings.Join(locales, "|")
	root := join("/", base)
	prefix := join("/", base, "/")
	defaultLocale := str(i18n["defaultLocale"])
	before, after, fallback := rewriteRoutes(routing, "beforeFiles", a.hasApp), rewriteRoutes(routing, "afterFiles", a.hasApp), rewriteRoutes(routing, "fallback", a.hasApp)
	priority, redirects, headers, onMatch := userRoutes(routing)
	out := []any{}
	add := func(rs ...object) {
		for _, r := range rs {
			out = append(out, r)
		}
	}
	dataEnabled := truth(routing["shouldNormalizeNextData"])
	out = append(out, priority...)
	out = append(out, dataRoutes(c, a.BuildID, dataEnabled, true, true)...)
	if hasI18n {
		destBase := ""
		if base != "" && base != "/" {
			destBase = root
		}
		slash := ""
		if trailing {
			slash = "/"
		}
		exclusion := `(?!(?:_next/.*|` + localePattern + `)(?:/.*|$))`
		add(object{"src": "^" + prefix + exclusion + "$", "dest": destBase + "$wildcard" + slash, "continue": true}, object{"src": "^" + prefix + exclusion + "(.*)$", "dest": destBase + "$wildcard/$1", "continue": true})
		if len(arr(i18n["domains"])) > 0 && i18n["localeDetection"] != false {
			dest := object{}
			for _, v := range arr(i18n["domains"]) {
				d := obj(v)
				protocol := "https://"
				if truth(d["http"]) {
					protocol = "http://"
				}
				domain := protocol + str(d["domain"])
				dest[str(d["defaultLocale"])] = domain + "/"
				for _, l := range arr(d["locales"]) {
					dest[str(l)] = domain + "/" + str(l)
				}
			}
			add(object{"src": "^" + root + "/?(?:" + localePattern + ")?/?$", "locale": object{"redirect": dest, "cookie": "NEXT_LOCALE"}, "continue": true})
		}
		if i18n["localeDetection"] != false {
			dest := object{}
			for _, l := range arr(i18n["locales"]) {
				p := "/" + str(l)
				if l == i18n["defaultLocale"] {
					p = "/"
				}
				dest[str(l)] = p
			}
			add(object{"src": "/", "locale": object{"redirect": dest, "cookie": "NEXT_LOCALE"}, "continue": true})
		}
		add(object{"src": "^" + root + "$", "dest": join("/", base, defaultLocale), "continue": true}, object{"src": "^" + prefix + exclusion + "(.*)$", "dest": join("/", base, defaultLocale) + "/$1", "continue": true})
	}
	out = append(out, headers...)
	out = append(out, redirects...)
	out = append(out, middleware...)
	out = append(out, before...)
	for _, code := range []int{404, 500} {
		src := join("/", base, fmt.Sprint(code)+"/?")
		if hasI18n {
			src = prefix + "(?:" + localePattern + ")?[/]?" + fmt.Sprint(code) + "/?"
		}
		r := object{"src": src, "status": code, "continue": true}
		if code == 404 {
			r["missing"] = []any{object{"type": "header", "key": "x-prerender-revalidate"}}
		}
		add(r)
	}
	out = append(out, dataRoutes(c, a.BuildID, dataEnabled, true, false)...)
	rsc := obj(routing["rsc"])
	if a.hasApp {
		segmentHas := []any{object{"type": "header", "key": rsc["header"], "value": "1"}, object{"type": "header", "key": rsc["prefetchHeader"], "value": "1"}, object{"type": "header", "key": rsc["prefetchSegmentHeader"], "value": "/(?<segmentPath>.+)"}}
		segmentSuffix := str(rsc["prefetchSegmentDirSuffix"]) + "/$segmentPath" + str(rsc["prefetchSegmentSuffix"])
		add(object{"src": join("/", base, "/(?<path>.+?)(?:/)?$"), "dest": join("/", base, "/$path"+segmentSuffix), "has": segmentHas, "continue": true, "override": true}, object{"src": join("^/", base, "/?$"), "dest": join("/", base, "/index"+segmentSuffix), "has": segmentHas, "continue": true, "override": true})
		has := []any{object{"type": "header", "key": rsc["header"], "value": "1"}}
		h := object{"vary": rsc["varyHeader"]}
		add(object{"src": "^" + join("/", base, "/?"), "has": has, "dest": join("/", base, "/index.rsc"), "headers": h, "continue": true, "override": true}, object{"src": "^" + join("/", base, `/((?!.+\.rsc).+?)(?:/)?$`), "has": has, "dest": join("/", base, "/$1.rsc"), "headers": h, "continue": true, "override": true})
	}
	add(object{"handle": "filesystem"})
	if base != "" {
		add(object{"src": join("/", base, "_next/image/?"), "dest": "/_next/image", "check": true})
	}
	out = append(out, dataRoutes(c, a.BuildID, dataEnabled, false, true)...)
	if !a.hasMiddleware {
		add(object{"src": join("/", base, "_next/data/(.*)"), "dest": join("/", base, "_next/data/$1"), "check": true})
	}
	if a.hasApp {
		add(object{"src": join("/", base, `/index(\.action|\.rsc)`), "dest": root, "continue": true})
	}
	out = append(out, after...)
	if a.hasApp {
		add(object{"src": join("/", base, `/\.rsc$`), "dest": join("/", base, "/index.rsc"), "check": true}, object{"src": join("/", base, `(.+)/\.rsc$`), "dest": join("/", base, "$1.rsc"), "check": true})
	}
	add(object{"handle": "resource"})
	out = append(out, fallback...)
	add(object{"src": join("/", base, ".*"), "status": 404}, object{"handle": "miss"}, object{"src": join("/", base, "_next/static/.+"), "status": 404, "check": true, "dest": join("/", base, "_next/static/not-found.txt"), "headers": object{"content-type": "text/plain; charset=utf-8"}})
	if hasI18n {
		if i18n["localeDetection"] == false {
			add(object{"src": "^" + root + "$", "dest": join("/", base, defaultLocale), "check": true}, object{"src": "^" + prefix + `(?!(?:_next/.*|` + localePattern + `)(?:/.*|$))(.*)$`, "dest": join("/", base, defaultLocale) + "/$1", "check": true})
		}
		add(object{"src": join("/", base, escapeRegexp(defaultLocale)), "dest": "/", "check": true}, object{"src": "^" + root + "/?(?:" + localePattern + ")/(.*)", "dest": prefix + "$1", "check": true})
	}
	if a.hasApp {
		add(object{"src": `^/(?<path>.+)(?<rscSuffix>\.segments/.+\.segment\.rsc)(?:/)?$`, "dest": "/$path.rsc", "check": true})
	}
	add(object{"handle": "rewrite"})
	out = append(out, dataRoutes(c, a.BuildID, dataEnabled, false, false)...)
	addedData404 := false
	for _, v := range arr(routing["dynamicRoutes"]) {
		r := obj(v)
		if a.hasPages && !a.hasMiddleware && !strings.Contains(str(r["sourceRegex"]), "_next/data") && !addedData404 {
			addedData404 = true
			add(object{"src": join("/", base, "_next/data/(.*)"), "dest": join("/", base, "404"), "status": 404, "check": true})
		}
		n := pick(r, "has", "missing")
		n["src"] = r["sourceRegex"]
		setFrom(n, "dest", r, "destination")
		n["check"] = true
		add(n)
	}
	if a.hasMiddleware {
		src := "^" + join("/", base, "/_next/data/", escapeRegexp(a.BuildID), "/(.*).json")
		add(object{"src": src, "headers": object{"x-nextjs-matched-path": "/$1"}, "continue": true, "override": true}, object{"src": src, "dest": "__next_data_catchall"})
	}
	add(object{"handle": "hit"})
	out = append(out, onMatch...)
	matchedSrc := `/(?:index)?(?:/)?$`
	if base != "" && base != "/" {
		matchedSrc = join("/", base, "/?(?:index)?(?:/)?$")
	}
	add(object{"src": matchedSrc, "headers": object{"x-matched-path": "/"}, "continue": true, "important": true}, object{"src": join("/", base, `/((?!index$).*?)(?:/)?$`), "headers": object{"x-matched-path": "/$1"}, "continue": true, "important": true}, object{"handle": "error"})
	notFound := "/_error"
	if a.hasNotFound {
		notFound = "/_not-found"
	} else if a.has404 {
		notFound = "/404"
	}
	errorSrcSuffix := ".*"
	if base != "" && base != "/" {
		errorSrcSuffix = "?.*"
	}
	if hasI18n {
		add(object{"src": prefix + "(?<nextLocale>" + localePattern + ")(/.*|$)", "dest": join("/", base, "/$nextLocale", notFound), "status": 404, "caseSensitive": true}, object{"src": join("/", base, ".*"), "dest": join("/", base, "/"+defaultLocale, notFound), "status": 404})
	} else {
		add(object{"src": join("/", base, errorSrcSuffix), "dest": join("/", base, notFound), "status": 404})
	}
	if hasI18n && a.has500 {
		add(object{"src": prefix + "(?<nextLocale>" + localePattern + ")(/.*|$)", "dest": join("/", base, "/$nextLocale/500"), "status": 500, "caseSensitive": true}, object{"src": join("/", base, ".*"), "dest": join("/", base, "/"+defaultLocale+"/500"), "status": 500})
	} else {
		dest := "/_error"
		if a.has500 {
			dest = "/500"
		}
		add(object{"src": join("/", base, errorSrcSuffix), "dest": join("/", base, dest), "status": 500})
	}
	return out
}

func (a *adapter) publicFiles() {
	public := filepath.Join(a.ProjectDir, "public")
	entries, err := os.ReadDir(public)
	if os.IsNotExist(err) {
		return
	}
	check(err)
	items := []any{}
	for _, e := range entries {
		items = append(items, object{"name": e.Name()})
	}
	parallel(items, func(o object) {
		name := str(o["name"])
		copyFile(filepath.Join(public, name), outputPath(filepath.Join(a.outputDir, "static"), join(str(a.Config["basePath"]), name)))
	})
}
