package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestConcurrentConfigClonesAndFallbackPreserveIndependentEdits(t *testing.T) {
	for _, supported := range []bool{true, false} {
		t.Run(map[bool]string{true: "cloned", false: "unsupported"}[supported], func(t *testing.T) {
			a := &adapter{request: request{RepoRoot: "/repo", AssetBindings: [][2]string{{"large", "/repo/" + strings.Repeat("x", 40*1024)}}, AssetMaps: [][]uint32{{0}}}}
			a.encodeBindings()
			var calls atomic.Int64
			cache := functionConfigs{clone: func(out, in *os.File) (bool, error) {
				calls.Add(1)
				if !supported {
					return false, nil
				}
				_, err := io.Copy(out, in)
				return err == nil, err
			}}
			root := t.TempDir()
			var wg sync.WaitGroup
			paths := make([]string, 16)
			for i := range paths {
				paths[i] = filepath.Join(root, string(rune('a'+i)), "config.json")
				wg.Add(1)
				go func(file string) {
					defer wg.Done()
					files := a.metadata(object{"assetMapId": float64(0)}, true)
					cache.write(file, object{"runtime": "nodejs"}, &files, nil)
				}(paths[i])
			}
			wg.Wait()
			if calls.Load() == 0 || (supported && calls.Load() != 15) {
				t.Fatalf("unexpected clone calls: %d", calls.Load())
			}
			if cache.cloneDisabled.Load() == supported {
				t.Fatal("incorrect filesystem support state")
			}
			if supported && cache.bytes.Load() != 0 {
				t.Fatal("cloned configs must not retain duplicate encoded buffers")
			}
			write(paths[0], []byte("postbuild edit"))
			for _, file := range paths[1:] {
				if readJSON(file)["runtime"] != "nodejs" {
					t.Fatal("editing a clone affected another output")
				}
			}
		})
	}
}

func TestCloneCacheDoesNotReusePreexistingOutputContent(t *testing.T) {
	a := &adapter{request: request{RepoRoot: "/repo", AssetBindings: [][2]string{{"large", "/repo/" + strings.Repeat("x", 40*1024)}}, AssetMaps: [][]uint32{{0}}}}
	a.encodeBindings()
	files := a.metadata(object{"assetMapId": float64(0)}, true)
	cache := functionConfigs{clone: func(out, in *os.File) (bool, error) {
		t.Fatal("preexisting content cannot be used as a clone source")
		return false, nil
	}}
	root := t.TempDir()
	existing, created := filepath.Join(root, "existing"), filepath.Join(root, "created")
	write(existing, []byte("preexisting content"))
	cache.write(existing, object{"runtime": "nodejs"}, &files, nil)
	cache.write(created, object{"runtime": "nodejs"}, &files, nil)
	if string(read(existing)) != "preexisting content" || readJSON(created)["runtime"] != "nodejs" {
		t.Fatal("reused preexisting content or failed to preserve it")
	}
}

func TestCloneConfigPreservesExistingFilesAndPropagatesIOErrors(t *testing.T) {
	root := t.TempDir()
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	write(source, []byte("source"))
	write(target, []byte("existing"))
	failure := errors.New("clone I/O failure")
	clone := func(out, in *os.File) (bool, error) { return false, failure }
	result, err := cloneConfigFile(source, target, clone)
	if err != nil || result != cloneExisting || string(read(target)) != "existing" {
		t.Fatal("overwrote existing output", err)
	}
	check(os.Remove(target))
	_, err = cloneConfigFile(source, target, clone)
	if !errors.Is(err, failure) || exists(target) {
		t.Fatal("failed clone must propagate error and remove incomplete output", err)
	}
}
