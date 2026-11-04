package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"time"
)

var profiling = os.Getenv("NEXT_ADAPTER_GO_PROFILE") == "1"

func startProfile() func() {
	if !profiling {
		return func() {}
	}
	fmt.Fprintf(os.Stderr, "[adapter-go-ready] %s\n", jsonText(object{"pid": os.Getpid(), "unixMs": float64(time.Now().UnixMicro()) / 1000, "gomaxprocs": runtime.GOMAXPROCS(0), "numCPU": runtime.NumCPU(), "goVersion": runtime.Version()}))
	dir, err := os.MkdirTemp("", "next-adapter-profile-")
	check(err)
	file, err := os.Create(filepath.Join(dir, "cpu.pprof"))
	check(err)
	check(pprof.StartCPUProfile(file))
	return func() {
		pprof.StopCPUProfile()
		check(file.Close())
		data, err := os.ReadFile(file.Name())
		check(err)
		encoded := base64.StdEncoding.EncodeToString(data)
		const size = 4000
		parts := (len(encoded) + size - 1) / size
		for i := 0; i < parts; i++ {
			end := (i + 1) * size
			if end > len(encoded) {
				end = len(encoded)
			}
			line, err := json.Marshal(object{"pid": os.Getpid(), "index": i, "parts": parts, "data": encoded[i*size : end]})
			check(err)
			fmt.Fprintf(os.Stderr, "[adapter-cpu-profile] %s\n", line)
		}
		check(os.RemoveAll(dir))
	}
}

func profilePhase(name string, fn func()) {
	if !profiling {
		fn()
		return
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	pprof.Do(context.Background(), pprof.Labels("phase", name), func(context.Context) { fn() })
	elapsed := time.Since(start)
	runtime.ReadMemStats(&after)
	line, err := json.Marshal(object{"pid": os.Getpid(), "phase": name, "durationMs": float64(elapsed.Microseconds()) / 1000, "allocatedBytes": after.TotalAlloc - before.TotalAlloc, "allocations": after.Mallocs - before.Mallocs, "heapBytes": after.HeapAlloc, "gcCycles": after.NumGC - before.NumGC})
	check(err)
	fmt.Fprintf(os.Stderr, "[adapter-go-phase] %s\n", line)
}
