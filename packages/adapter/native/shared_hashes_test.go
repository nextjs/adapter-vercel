package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestSharedHashesRollingAdmissionAndLiveSnapshot(t *testing.T) {
	t.Setenv("NEXT_ADAPTER_GO_WORKERS", "1")
	a := &adapter{sharedHashMaps: map[float64]*metadataMap{0: {id: -1}}}
	outputs := make([]any, 17)
	release := make([]chan struct{}, 16)
	for i := range outputs {
		outputs[i] = object{"index": i, "assetHashIdentity": float64(0)}
		if i < 16 {
			release[i] = make(chan struct{})
		}
	}
	started := make(chan int, 17)
	serialized := make(chan object, 17)
	late := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.parallelNodes(outputs, func(o object) {
			i := o["index"].(int)
			started <- i
			hashes := metadataMap{id: -1}
			if i < 16 {
				<-release[i]
			} else {
				a.updateNodeHashes(o, &hashes, func(h *metadataMap) { h.set("late", "hash") })
				close(late)
			}
			a.snapshotNodeHashes(o, &hashes)
			var snapshot object
			check(json.Unmarshal(hashes.appendJSON(nil), &snapshot))
			serialized <- snapshot
		})
	}()
	defer func() {
		for _, ch := range release {
			select {
			case <-ch:
			default:
				close(ch)
			}
		}
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("workers did not finish")
		}
	}()
	for range 16 {
		select {
		case i := <-started:
			if i == 16 {
				t.Fatal("queued output started before a slot was released")
			}
		case <-time.After(10 * time.Second):
			t.Fatal("shared aliases must retain sixteen in-flight slots")
		}
	}
	close(release[0])
	select {
	case first := <-serialized:
		if first["late"] != nil {
			t.Fatal("future output contaminated the first config")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("first config did not serialize")
	}
	select {
	case <-late:
	case <-time.After(10 * time.Second):
		t.Fatal("next output was not admitted")
	}
	for _, ch := range release[1:] {
		close(ch)
	}
	<-done
	for range 16 {
		if snapshot := <-serialized; snapshot["late"] != "hash" {
			t.Fatal("snapshot did not observe live shared mutation", snapshot)
		}
	}
}
