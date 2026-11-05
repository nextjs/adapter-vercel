package main

import (
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Trace bindings recur in hundreds of functions. Quote each binding once, then
// append its JSON bytes without rebuilding, boxing and sorting a map per output.
type encodedBinding struct {
	name       string
	file, hash []byte
}

func (a *adapter) encodeBindings() {
	a.encodedBindings = make([]encodedBinding, len(a.AssetBindings))
	for i, entry := range a.AssetBindings {
		prefix := jsonText(entry[0]) + ":"
		b := encodedBinding{name: entry[0], hash: []byte(prefix + jsonText(entry[1]))}
		if filepath.IsAbs(entry[1]) {
			b.file = []byte(prefix + jsonText(a.relative(entry[1])))
		}
		a.encodedBindings[i] = b
	}
}

type metadataMap struct {
	a       *adapter
	refs    []uint32
	paths   bool
	id      int
	extra   map[string]string
	deleted map[string]bool
}

func (a *adapter) metadata(o object, paths bool) metadataMap {
	legacy, field := "assetsHashes", "assetHashMapId"
	if paths {
		legacy, field = "assets", "assetMapId"
	}
	m := metadataMap{a: a, paths: paths, id: -1}
	if refs, ok := a.mapRefs(o, field); ok {
		m.refs = refs
		m.id = int(o[field].(float64))
		return m
	}
	for name, value := range obj(o[legacy]) {
		v := str(value)
		if paths {
			v = a.relative(v)
		}
		m.set(name, v)
	}
	return m
}

func (m *metadataMap) set(name, value string) {
	if m.extra == nil {
		m.extra = make(map[string]string, 4)
	}
	m.extra[name] = value
	delete(m.deleted, name)
}

func (m *metadataMap) setFrom(name string, src object) {
	if value, ok := src[name]; ok {
		m.set(name, str(value))
		return
	}
	delete(m.extra, name)
	if m.deleted == nil {
		m.deleted = make(map[string]bool)
	}
	m.deleted[name] = true
}

func (m *metadataMap) appendJSON(dst []byte) []byte {
	dst = append(dst, '{')
	first := true
	for _, id := range m.refs {
		if uint64(id) >= uint64(len(m.a.encodedBindings)) {
			panic("invalid asset binding reference")
		}
		entry := &m.a.encodedBindings[id]
		if _, overridden := m.extra[entry.name]; overridden || m.deleted[entry.name] {
			continue
		}
		value := entry.hash
		if m.paths {
			value = entry.file
			if value == nil {
				panic("asset path must be absolute")
			}
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = append(dst, value...)
	}
	for name, value := range m.extra {
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = append(dst, jsonText(name)...)
		dst = append(dst, ':')
		dst = append(dst, jsonText(value)...)
	}
	return append(dst, '}')
}

var functionJSONBuffers = sync.Pool{New: func() any { return make([]byte, 0, 64*1024) }}

func configPrefix(cfg object, hashes *metadataMap) string {
	delete(cfg, "filePathMap")
	if hashes != nil {
		delete(cfg, "fileHashes")
	}
	return jsonText(cfg)
}

func writeFunctionConfig(file string, cfg object, files, hashes *metadataMap) bool {
	return renderFunctionConfig(file, configPrefix(cfg, hashes), files, hashes)
}

func renderFunctionConfig(file, prefix string, files, hashes *metadataMap) bool {
	buffer := functionJSONBuffers.Get().([]byte)[:0]
	defer func() { functionJSONBuffers.Put(buffer[:0]) }()
	buffer = append(buffer, prefix[:len(prefix)-1]...)
	if prefix != "{}" {
		buffer = append(buffer, ',')
	}
	buffer = append(buffer, `"filePathMap":`...)
	buffer = files.appendJSON(buffer)
	if hashes != nil {
		buffer = append(buffer, `,"fileHashes":`...)
		buffer = hashes.appendJSON(buffer)
	}
	buffer = append(buffer, '}')
	if profiling {
		encodedConfigBytes.Add(uint64(len(buffer)))
		encodedConfigs.Add(1)
	}
	return writeOnce(file, buffer)
}

// Reuse completed content while keeping output files independent for postbuild
// edits. io.Copy uses the kernel's file-copy path where available.
type sharedPath struct {
	once   sync.Once
	source string
}

func (s *sharedPath) write(file string, generate func(string) bool) {
	first := false
	s.once.Do(func() {
		first = true
		if generate(file) {
			s.source = file
		}
	})
	if first || s.source == file {
		return
	}
	if s.source != "" {
		mkdir(filepath.Dir(file))
		input, err := os.Open(s.source)
		if err == nil {
			defer input.Close()
			output, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
			if os.IsExist(err) {
				return
			}
			check(err)
			_, copyErr := io.Copy(output, input)
			closeErr := output.Close()
			check(copyErr)
			check(closeErr)
			return
		}
	}
	generate(file)
}

type metadataIdentity struct {
	id             int
	extra, deleted string
}

func (m *metadataMap) identity() metadataIdentity {
	return metadataIdentity{m.id, jsonText(m.extra), jsonText(m.deleted)}
}

type functionConfigIdentity struct {
	prefix        string
	files, hashes metadataIdentity
	hasHashes     bool
}
type functionConfigs struct{ entries sync.Map }

func (c *functionConfigs) write(file string, cfg object, files, hashes *metadataMap) {
	prefix := configPrefix(cfg, hashes)
	key := functionConfigIdentity{prefix: prefix, files: files.identity(), hasHashes: hashes != nil}
	if hashes != nil {
		key.hashes = hashes.identity()
	}
	entry, _ := c.entries.LoadOrStore(key, &sharedPath{})
	entry.(*sharedPath).write(file, func(file string) bool { return renderFunctionConfig(file, prefix, files, hashes) })
}
