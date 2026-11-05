package main

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"sort"
)

type sharedMapReference struct {
	ID        int               `json:"id"`
	Overrides map[string]string `json:"overrides,omitempty"`
	Deleted   []string          `json:"deleted,omitempty"`
}

type sharedFunctionTraces struct {
	Version int                 `json:"version"`
	Table   string              `json:"table"`
	Paths   sharedMapReference  `json:"paths"`
	Hashes  *sharedMapReference `json:"hashes,omitempty"`
}

func (m *metadataMap) sharedReference() sharedMapReference {
	r := sharedMapReference{ID: m.id, Overrides: m.extra}
	for name, deleted := range m.deleted {
		if deleted {
			r.Deleted = append(r.Deleted, name)
		}
	}
	sort.Strings(r.Deleted)
	return r
}

// Each binding carries both interpretations: paths are repository-relative,
// while hash values remain literal, including strings that resemble paths.
type sharedTraceBinding [3]any

func (a *adapter) writeSharedTraceTable() {
	bindings := make([]sharedTraceBinding, len(a.AssetBindings))
	parts := min(max(1, runtime.GOMAXPROCS(0)), max(1, len(bindings)))
	chunks := make([]any, parts)
	for i := range chunks {
		chunks[i] = object{"part": i}
	}
	a.parallel("shared-traces", chunks, func(o object) {
		part := o["part"].(int)
		for i := len(bindings) * part / parts; i < len(bindings)*(part+1)/parts; i++ {
			entry := a.AssetBindings[i]
			var path any
			if filepath.IsAbs(entry[1]) {
				path = a.relative(entry[1])
			}
			bindings[i] = sharedTraceBinding{entry[0], path, entry[1]}
		}
	})
	data, err := json.Marshal(struct {
		Version  int                  `json:"version"`
		Bindings []sharedTraceBinding `json:"bindings"`
		Maps     [][]uint32           `json:"maps"`
	}{1, bindings, a.AssetMaps})
	check(err)
	a.traceTable = ".vc-traces-" + hash(data) + ".json"
	writeOnce(filepath.Join(a.outputDir, "functions", a.traceTable), data)
}

func (a *adapter) writeSharedFunctionConfig(file, prefix string, paths, hashes *metadataMap) {
	r := sharedFunctionTraces{Version: 1, Table: a.traceTable, Paths: paths.sharedReference()}
	if hashes != nil {
		ref := hashes.sharedReference()
		r.Hashes = &ref
	}
	// Prefixes are complete JSON objects; append one experimental extension.
	data := []byte(prefix[:len(prefix)-1])
	if prefix != "{}" {
		data = append(data, ',')
	}
	data = append(data, `"experimentalTraceReferences":`...)
	data = append(data, jsonText(r)...)
	data = append(data, '}')
	writeOnceInDirectory(file, data)
}
