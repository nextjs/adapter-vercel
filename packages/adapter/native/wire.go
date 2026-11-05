package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const requestMagic = "NXTADP3\n"

func decodeRequest(input io.Reader) (request, error) {
	var req request
	data, err := io.ReadAll(input)
	if err != nil {
		return req, err
	}
	if !bytes.HasPrefix(data, []byte(requestMagic)) {
		return req, json.Unmarshal(data, &req)
	}
	invalid := func() (request, error) { return request{}, fmt.Errorf("invalid native adapter request frame") }
	if len(data) < 12 {
		return invalid()
	}
	jsonSize := uint64(binary.LittleEndian.Uint32(data[8:12]))
	if jsonSize > uint64(len(data)-12) {
		return invalid()
	}
	if err := json.Unmarshal(data[12:12+jsonSize], &req); err != nil {
		return request{}, err
	}
	if req.Version != 3 || req.AssetMaps != nil {
		return invalid()
	}
	data = data[12+jsonSize:]
	if len(data) < 4 {
		return invalid()
	}
	mapCount := uint64(binary.LittleEndian.Uint32(data))
	data = data[4:]
	if mapCount > uint64(len(data)/4) {
		return invalid()
	}
	// Validate all lengths before allocating. Keep map references in one typed
	// allocation instead of parsing/allocating each decimal JSON number.
	tail, total := data, 0
	for i := uint64(0); i < mapCount; i++ {
		if len(tail) < 4 {
			return invalid()
		}
		n := uint64(binary.LittleEndian.Uint32(tail))
		tail = tail[4:]
		if n > uint64(len(tail)/4) {
			return invalid()
		}
		total += int(n)
		tail = tail[n*4:]
	}
	if len(tail) != 0 {
		return invalid()
	}
	req.AssetMaps = make([][]uint32, int(mapCount))
	refs := make([]uint32, total)
	for i := range req.AssetMaps {
		n := int(binary.LittleEndian.Uint32(data))
		data = data[4:]
		values := refs[:n:n]
		refs = refs[n:]
		for j := range values {
			id := binary.LittleEndian.Uint32(data[j*4:])
			if uint64(id) >= uint64(len(req.AssetBindings)) {
				return request{}, fmt.Errorf("invalid asset binding reference")
			}
			values[j] = id
		}
		req.AssetMaps[i] = values
		data = data[n*4:]
	}
	return req, nil
}

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
