package main

import (
	"runtime"
	"sync/atomic"
	"testing"
)

func TestOutputWorkersBoundConcurrentPhases(t *testing.T) {
	p := newOutputWorkers(3)
	defer p.close()
	items := make([]any, 30)
	var active, peak, completed atomic.Int64
	fn := func(object) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		runtime.Gosched()
		completed.Add(1)
	}
	concurrentPhases(func() { p.run("assets", items, fn) }, func() { p.run("functions", items, fn) })
	if completed.Load() != 60 || peak.Load() > 3 || peak.Load() < 2 {
		t.Fatalf("completed=%d peak=%d", completed.Load(), peak.Load())
	}
}

func TestOutputPhaseFailureDrainsOtherWriters(t *testing.T) {
	p := newOutputWorkers(2)
	defer p.close()
	items := make([]any, 10)
	var completed atomic.Int64
	failed := false
	func() {
		defer func() { failed = recover() != nil }()
		concurrentPhases(
			func() { p.run("failing", items, func(object) { completed.Add(1); panic("write failure") }) },
			func() { p.run("finishing", items, func(object) { completed.Add(1) }) },
		)
	}()
	if !failed || completed.Load() != 20 {
		t.Fatalf("failed=%v completed=%d", failed, completed.Load())
	}
}

func TestOutputWorkerOverrideValidation(t *testing.T) {
	t.Setenv("NEXT_ADAPTER_GO_WORKERS", "8")
	if outputConcurrency() != 8 {
		t.Fatal("worker override ignored")
	}
	for _, value := range []string{"0", "129", "invalid"} {
		t.Setenv("NEXT_ADAPTER_GO_WORKERS", value)
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("accepted workers=%s", value)
				}
			}()
			outputConcurrency()
		}()
	}
}
