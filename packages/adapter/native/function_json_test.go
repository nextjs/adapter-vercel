package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestFunctionMetadataOverridesAndMissingHashes(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo", AssetBindings: [][2]string{{"shared", "/repo/shared.js"}, {"special\"\\\u2028", "/repo/line\u2029.js"}, {"shared", "hash-shared"}, {"deleted", "hash-deleted"}}, AssetMaps: [][]uint32{{0, 1}, {2, 3}}}}
	a.encodeBindings()
	o := object{"assetMapId": float64(0), "assetHashMapId": float64(1)}
	files, hashes := a.metadata(o, true), a.metadata(o, false)
	files.set("shared", "replacement.js")
	hashes.setFrom("shared", object{"shared": "replacement-hash"})
	hashes.setFrom("deleted", object{})
	files.set("new", "new.js")
	file := filepath.Join(t.TempDir(), "config.json")
	writeFunctionConfig(file, object{"runtime": "nodejs", "filePathMap": "overridden", "fileHashes": "overridden"}, &files, &hashes)
	actual := readJSON(file)
	want := object{"runtime": "nodejs", "filePathMap": object{"shared": "replacement.js", "special\"\\\u2028": "line\u2029.js", "new": "new.js"}, "fileHashes": object{"shared": "replacement-hash"}}
	x, _ := json.Marshal(actual)
	y, _ := json.Marshal(want)
	if string(x) != string(y) {
		t.Fatalf("got %s, want %s", x, y)
	}
	// Rendering an override must leave the shared dictionaries intact.
	original := a.metadata(o, false)
	var value object
	check(json.Unmarshal(original.appendJSON(nil), &value))
	if value["deleted"] != "hash-deleted" || value["shared"] != "hash-shared" {
		t.Fatal(value)
	}
}

func TestConcurrentFunctionConfigsShareCompletedFiles(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo", AssetBindings: [][2]string{{"shared", "/repo/shared.js"}, {"shared", "hash"}}, AssetMaps: [][]uint32{{0}, {1}}}}
	a.encodeBindings()
	o := object{"assetMapId": float64(0), "assetHashMapId": float64(1)}
	var cache functionConfigs
	root := t.TempDir()
	paths := make([]string, 16)
	var wg sync.WaitGroup
	for i := range paths {
		paths[i] = filepath.Join(root, string(rune('a'+i)), "config.json")
		wg.Add(1)
		go func(file string) {
			defer wg.Done()
			files, hashes := a.metadata(o, true), a.metadata(o, false)
			cache.write(file, object{"runtime": "nodejs"}, &files, &hashes)
		}(paths[i])
	}
	wg.Wait()
	first, err := os.Stat(paths[0])
	check(err)
	for _, file := range paths {
		info, err := os.Stat(file)
		check(err)
		if !os.SameFile(first, info) {
			t.Fatal("identical configs were not shared")
		}
		if obj(readJSON(file)["fileHashes"])["shared"] != "hash" {
			t.Fatal("incomplete shared config")
		}
	}
}

func TestConfigSharingPreservesExistingFilesAndDifferentOptions(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo"}}
	files := a.metadata(object{}, true)
	var cache functionConfigs
	root := t.TempDir()
	existing := filepath.Join(root, "existing.json")
	write(existing, []byte("existing content"))
	cache.write(existing, object{"memory": float64(1024)}, &files, nil)
	created := filepath.Join(root, "created.json")
	cache.write(created, object{"memory": float64(1024)}, &files, nil)
	different := filepath.Join(root, "different.json")
	cache.write(different, object{"memory": float64(2048)}, &files, nil)
	if string(read(existing)) != "existing content" {
		t.Fatal("overwrote an existing file")
	}
	if readJSON(created)["memory"] != float64(1024) || readJSON(different)["memory"] != float64(2048) {
		t.Fatal("shared files with different options")
	}
}

func TestFunctionMetadataAbsentAndEmptyHashes(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo"}}
	files := a.metadata(object{}, true)
	hashes := a.metadata(object{}, false)
	for _, present := range []bool{false, true} {
		file := filepath.Join(t.TempDir(), "config.json")
		var h *metadataMap
		if present {
			h = &hashes
		}
		writeFunctionConfig(file, object{}, &files, h)
		cfg := readJSON(file)
		if _, exists := cfg["fileHashes"]; exists != present {
			t.Fatal(cfg)
		}
		if len(obj(cfg["filePathMap"])) != 0 {
			t.Fatal(cfg)
		}
	}
}
