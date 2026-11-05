package main

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSharedTraceRoundTripMatchesExpandedConfig(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo", AssetBindings: [][2]string{{"shared", "/repo/shared.js"}, {"__proto__", "/repo/quoted\"\u2028.js"}, {"shared", "/literal-hash"}, {"deleted", "hash-deleted"}}, AssetMaps: [][]uint32{{0, 1}, {2, 3}}}, outputDir: t.TempDir()}
	a.writeSharedTraceTable()
	data := read(filepath.Join(a.outputDir, "functions", a.traceTable))
	if a.traceTable != ".vc-traces-"+hash(data)+".json" {
		t.Fatal("trace table must be content addressed")
	}
	var table struct {
		Bindings []sharedTraceBinding
		Maps     [][]uint32
	}
	check(json.Unmarshal(data, &table))
	expand := func(ref sharedMapReference, paths bool) object {
		m := object{}
		if ref.ID >= 0 {
			for _, id := range table.Maps[ref.ID] {
				b := table.Bindings[id]
				index := 2
				if paths {
					index = 1
				}
				m[b[0].(string)] = b[index]
			}
		}
		for _, name := range ref.Deleted {
			delete(m, name)
		}
		for name, value := range ref.Overrides {
			m[name] = value
		}
		return m
	}
	for _, inline := range []bool{false, true} {
		for _, hasHashes := range []bool{false, true} {
			o := object{"assetMapId": float64(0), "assetHashMapId": float64(1)}
			if inline {
				o = object{"assets": object{"local": "/repo/local.js"}}
			}
			files, hashes := a.metadata(o, true), a.metadata(o, false)
			files.set("shared", "replacement.js")
			hashes.setFrom("deleted", object{})
			var h *metadataMap
			if hasHashes {
				h = &hashes
			}
			file := filepath.Join(t.TempDir(), "config.json")
			a.writeSharedFunctionConfig(file, "{}", &files, h)
			var cfg struct {
				Refs sharedFunctionTraces `json:"experimentalTraceReferences"`
			}
			check(json.Unmarshal(read(file), &cfg))
			a.encodeBindings()
			var expected object
			check(json.Unmarshal(appendFunctionConfig(nil, "{}", &files, h), &expected))
			actual := object{"filePathMap": expand(cfg.Refs.Paths, true)}
			if cfg.Refs.Hashes != nil {
				actual["fileHashes"] = expand(*cfg.Refs.Hashes, false)
			}
			if !reflect.DeepEqual(expected, actual) {
				t.Fatalf("got %#v, want %#v", actual, expected)
			}
			if strings.Contains(string(read(file)), "filePathMap") {
				t.Fatal("expanded trace leaked into compact config")
			}
		}
	}
}
