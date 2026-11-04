package main

import "fmt"

func (a *adapter) mapRefs(o object, field string) ([]uint32, bool) {
	v, present := o[field]
	if !present || v == nil {
		return nil, false
	}
	id, ok := v.(float64)
	index := int(id)
	if !ok || float64(index) != id || index < 0 || index >= len(a.AssetMaps) {
		panic(fmt.Errorf("invalid %s reference", field))
	}
	return a.AssetMaps[index], true
}

func (a *adapter) eachMap(o object, legacy, field string, fn func(string, string)) {
	if refs, packed := a.mapRefs(o, field); packed {
		for _, id := range refs {
			if uint64(id) >= uint64(len(a.AssetBindings)) {
				panic("invalid asset binding reference")
			}
			entry := a.AssetBindings[id]
			fn(entry[0], entry[1])
		}
		return
	}
	for name, value := range obj(o[legacy]) {
		fn(name, str(value))
	}
}

func (a *adapter) assets(o object) object {
	result := object{}
	a.eachMap(o, "assets", "assetMapId", func(k, v string) { result[k] = v })
	return result
}

func (a *adapter) hashes(o object) object {
	size := len(obj(o["assetsHashes"]))
	if refs, ok := a.mapRefs(o, "assetHashMapId"); ok {
		size = len(refs)
	}
	result := make(object, size+4)
	a.eachMap(o, "assetsHashes", "assetHashMapId", func(k, v string) { result[k] = v })
	return result
}

func (a *adapter) relative(p string) string {
	if cached, ok := a.relativePaths[p]; ok {
		return cached
	}
	return rel(a.RepoRoot, p)
}
