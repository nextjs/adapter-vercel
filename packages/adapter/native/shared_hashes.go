package main

import "maps"

// The TypeScript adapter mutates assetsHashes, which Next may alias across
// outputs. Transport map IDs deduplicate equal contents, so they cannot stand
// in for object identity. Keep overlays only for actual shared hash objects.
func (a *adapter) initSharedHashes() {
	counts := map[float64]int{}
	outputs := []any{}
	for _, key := range []string{"appPages", "appRoutes", "pages", "pagesApi"} {
		outputs = append(outputs, arr(a.Outputs[key])...)
	}
	if middleware := a.Outputs["middleware"]; middleware != nil {
		outputs = append(outputs, middleware)
	}
	for _, value := range outputs {
		o := obj(value)
		if id, ok := o["assetHashIdentity"].(float64); ok && o["runtime"] == "nodejs" {
			counts[id]++
		}
	}
	a.sharedHashMaps = map[float64]*metadataMap{}
	for _, value := range outputs {
		o := obj(value)
		if id, ok := o["assetHashIdentity"].(float64); ok && counts[id] > 1 && a.sharedHashMaps[id] == nil {
			m := a.metadata(o, false)
			a.sharedHashMaps[id] = &m
		}
	}
}

func (a *adapter) sharedHashes(o object) *metadataMap {
	id, ok := o["assetHashIdentity"].(float64)
	if !ok {
		return nil
	}
	return a.sharedHashMaps[id]
}

func (a *adapter) updateNodeHashes(o object, local *metadataMap, update func(*metadataMap)) {
	if len(a.sharedHashMaps) == 0 {
		update(local)
		return
	}
	a.hashMu.Lock()
	defer a.hashMu.Unlock()
	if shared := a.sharedHashes(o); shared != nil {
		update(shared)
	} else {
		update(local)
	}
}

func (a *adapter) snapshotNodeHashes(o object, local *metadataMap) {
	if shared := a.sharedHashes(o); shared != nil {
		a.hashMu.Lock()
		defer a.hashMu.Unlock()
		*local = *shared
		local.extra, local.deleted = maps.Clone(shared.extra), maps.Clone(shared.deleted)
	}
}

func (a *adapter) parallelNodes(outputs []any, fn func(object)) {
	if len(a.sharedHashMaps) == 0 {
		a.parallel("node", outputs, fn)
		return
	}
	// Aliases make admission observable. Retain TypeScript's rolling sixteen
	// slots for the whole phase, including outputs with independent hashes.
	p := newOutputWorkers(min(16, len(outputs)))
	defer p.close()
	p.run("node", outputs, fn)
}
