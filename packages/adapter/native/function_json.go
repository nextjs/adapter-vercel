package main

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
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
	// Size each shared map once. Reserving a whole power-of-two buffer per
	// config otherwise wastes enough cache capacity to evict reusable configs.
	a.encodedMapSizes = make([][2]int, len(a.AssetMaps))
	for i, refs := range a.AssetMaps {
		sizes := [2]int{2, 2}
		for j, id := range refs {
			if uint64(id) >= uint64(len(a.encodedBindings)) {
				panic("invalid asset binding reference")
			}
			entry := a.encodedBindings[id]
			sizes[0] += len(entry.file)
			sizes[1] += len(entry.hash)
			if j > 0 {
				sizes[0]++
				sizes[1]++
			}
		}
		a.encodedMapSizes[i] = sizes
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
	return renderFunctionConfigWith(file, prefix, files, hashes, writeOnce)
}

func renderFunctionConfigWith(file, prefix string, files, hashes *metadataMap, write func(string, []byte) bool) bool {
	buffer := functionJSONBuffers.Get().([]byte)[:0]
	defer func() { functionJSONBuffers.Put(buffer[:0]) }()
	buffer = appendFunctionConfig(buffer, prefix, files, hashes)
	return write(file, buffer)
}

func appendFunctionConfig(buffer []byte, prefix string, files, hashes *metadataMap) []byte {
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
	return buffer
}

type metadataIdentity struct {
	id             int
	extra, deleted string
}

func (m *metadataMap) identity() metadataIdentity {
	return metadataIdentity{m.id, jsonText(m.extra), jsonText(m.deleted)}
}

func (m *metadataMap) capacity(extra string) int {
	base := 2
	if m.id >= 0 {
		kind := 1
		if m.paths {
			kind = 0
		}
		base = m.a.encodedMapSizes[m.id][kind]
	}
	// Keeping overridden/deleted entries in the estimate gives a cheap upper
	// bound, with only a few extra bytes for the small per-function overlays.
	return base + len(extra)
}

type functionConfigIdentity struct {
	prefix        string
	files, hashes metadataIdentity
	hasHashes     bool
}
type cachedFunctionConfig struct {
	once   sync.Once
	data   []byte
	source string
}
type functionConfigs struct {
	entries       sync.Map
	bytes         atomic.Int64
	clone         func(*os.File, *os.File) (bool, error)
	cloneDisabled atomic.Bool
}

const functionConfigCacheLimit = 64 << 20

func (c *functionConfigs) reserve(size int) bool {
	for {
		used := c.bytes.Load()
		if int64(size) > functionConfigCacheLimit-used {
			return false
		}
		if c.bytes.CompareAndSwap(used, used+int64(size)) {
			return true
		}
	}
}

func (c *functionConfigs) write(file string, cfg object, files, hashes *metadataMap) {
	mkdir(filepath.Dir(file))
	c.writeWith(file, cfg, files, hashes, writeOnceInDirectory)
}

func (c *functionConfigs) writeInDirectory(file string, cfg object, files, hashes *metadataMap) {
	c.writeWith(file, cfg, files, hashes, writeOnceInDirectory)
}

func (c *functionConfigs) writeWith(file string, cfg object, files, hashes *metadataMap, write func(string, []byte) bool) {
	prefix := configPrefix(cfg, hashes)
	key := functionConfigIdentity{prefix: prefix, files: files.identity(), hasHashes: hashes != nil}
	if hashes != nil {
		key.hashes = hashes.identity()
	}
	value, _ := c.entries.LoadOrStore(key, &cachedFunctionConfig{})
	entry := value.(*cachedFunctionConfig)
	var generated []byte
	wroteFirst := false
	entry.once.Do(func() {
		capacity := len(prefix) + len(`,"filePathMap":`) + files.capacity(key.files.extra)
		if hashes != nil {
			capacity += len(`,"fileHashes":`) + hashes.capacity(key.hashes.extra)
		}
		generated = appendFunctionConfig(make([]byte, 0, capacity), prefix, files, hashes)
		if c.reserve(cap(generated)) {
			entry.data = generated
		}
		if c.clone != nil && !c.cloneDisabled.Load() && len(generated) >= 32*1024 {
			if write(file, generated) {
				entry.source = file
			}
			wroteFirst = true
		}
	})
	if wroteFirst {
		return
	}
	if entry.source != "" && !c.cloneDisabled.Load() {
		result, err := cloneConfigFile(entry.source, file, c.clone)
		check(err)
		if result != cloneUnsupported {
			if result == cloneWritten {
				clonedConfigs.Add(1)
			}
			return
		}
		c.cloneDisabled.Store(true)
	}
	if entry.data != nil {
		write(file, entry.data)
		return
	}
	if generated != nil {
		write(file, generated)
		return
	}
	renderFunctionConfigWith(file, prefix, files, hashes, write)
}
