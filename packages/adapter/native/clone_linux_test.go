package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxReflinkCreatesIndependentFiles(t *testing.T) {
	root, err := os.MkdirTemp(".", "native-reflink-test-")
	check(err)
	t.Cleanup(func() { check(os.RemoveAll(root)) })
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	write(source, []byte("original bytes"))
	result, err := cloneConfigFile(source, target, cloneContents)
	if err != nil {
		t.Fatal(err)
	}
	if result == cloneUnsupported {
		t.Skip("filesystem does not support reflinks; fallback tested separately")
	}
	a, err := os.Stat(source)
	check(err)
	b, err := os.Stat(target)
	check(err)
	if os.SameFile(a, b) || string(read(target)) != "original bytes" {
		t.Fatal("clone must have an independent inode and matching bytes")
	}
	write(target, []byte("postbuild edit"))
	if string(read(source)) != "original bytes" {
		t.Fatal("editing the cloned file changed its source")
	}
	write(source, []byte("source edit"))
	if string(read(target)) != "postbuild edit" {
		t.Fatal("editing the source changed its clone")
	}
}
