package main

import (
	"context"
	"os"
	"runtime"
	"runtime/pprof"
	"strconv"
	"sync"
)

type outputJob struct {
	phase string
	fn    func()
}

type outputWorkers struct {
	jobs chan outputJob
	wg   sync.WaitGroup
}

func outputConcurrency() int {
	if value := os.Getenv("NEXT_ADAPTER_GO_WORKERS"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > 128 {
			panic("NEXT_ADAPTER_GO_WORKERS must be between 1 and 128")
		}
		return n
	}
	return min(128, max(4, runtime.GOMAXPROCS(0)*4))
}

func newOutputWorkers(n int) *outputWorkers {
	p := &outputWorkers{jobs: make(chan outputJob)}
	for i := 0; i < n; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for job := range p.jobs {
				if profiling {
					pprof.Do(context.Background(), pprof.Labels("phase", job.phase), func(context.Context) { job.fn() })
				} else {
					job.fn()
				}
			}
		}()
	}
	return p
}

func (p *outputWorkers) close() { close(p.jobs); p.wg.Wait() }

func (p *outputWorkers) run(phase string, items []any, fn func(object)) {
	var wg sync.WaitGroup
	var once sync.Once
	var failure any
	for _, item := range items {
		item := item
		wg.Add(1)
		p.jobs <- outputJob{phase: phase, fn: func() {
			defer wg.Done()
			defer func() {
				if err := recover(); err != nil {
					once.Do(func() { failure = err })
				}
			}()
			fn(obj(item))
		}}
	}
	wg.Wait()
	if failure != nil {
		panic(failure)
	}
}

func parallel(items []any, fn func(object)) {
	if len(items) == 0 {
		return
	}
	p := newOutputWorkers(min(len(items), outputConcurrency()))
	defer p.close()
	p.run("output", items, fn)
}

func (a *adapter) parallel(phase string, items []any, fn func(object)) {
	if a.workers == nil {
		parallel(items, fn)
		return
	}
	a.workers.run(phase, items, fn)
}

// Join every phase before propagating failure, so no writer can outlive the
// build hook or race with route serialization and Next.js asset cleanup.
func concurrentPhases(phases ...func()) {
	var wg sync.WaitGroup
	var once sync.Once
	var failure any
	for _, phase := range phases {
		phase := phase
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if err := recover(); err != nil {
					once.Do(func() { failure = err })
				}
			}()
			phase()
		}()
	}
	wg.Wait()
	if failure != nil {
		panic(failure)
	}
}
