//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCopyPreservesSourcePermissionsDespiteUmask(t *testing.T) {
	previous := syscall.Umask(0077)
	defer syscall.Umask(previous)
	for _, mode := range []os.FileMode{0666, 0775, 0640, 0644 | os.ModeSticky} {
		root := t.TempDir()
		source, destination := filepath.Join(root, "source"), filepath.Join(root, "copied")
		check(os.WriteFile(source, []byte("source"), 0600))
		check(os.Chmod(source, mode))
		copyFile(source, destination)
		info, err := os.Stat(destination)
		check(err)
		if info.Mode() != mode {
			t.Fatalf("copy mode %v, want %v", info.Mode(), mode)
		}
	}
	root := t.TempDir()
	source, destination := filepath.Join(root, "source"), filepath.Join(root, "copied")
	check(os.Mkdir(source, 0700))
	check(os.Chmod(source, 0777|os.ModeSticky))
	copyFile(source, destination)
	info, err := os.Stat(destination)
	check(err)
	if info.Mode() != 0777|os.ModeSticky|os.ModeDir {
		t.Fatal("directory permissions changed", info.Mode())
	}
}

func TestGeneratedFilesRetainNodeCreationDefaults(t *testing.T) {
	for _, mask := range []int{0, 0027} {
		func() {
			previous := syscall.Umask(mask)
			defer syscall.Umask(previous)
			root := t.TempDir()
			writers := []func(string){
				func(p string) { write(p, []byte("bytes")) },
				func(p string) { writeOnce(p, []byte("once")) },
				func(p string) { writeJSON(p, object{"value": true}) },
				func(p string) { writeJSONOnce(p, object{"value": true}) },
			}
			for i, writer := range writers {
				p := filepath.Join(root, string(rune('a'+i)), "file")
				writer(p)
				info, err := os.Stat(p)
				check(err)
				if info.Mode().Perm() != os.FileMode(0666&^mask) {
					t.Fatal("file creation differs from fs.writeFile", info.Mode())
				}
				dir, err := os.Stat(filepath.Dir(p))
				check(err)
				if dir.Mode().Perm() != os.FileMode(0777&^mask) {
					t.Fatal("directory creation differs from fs.mkdir", dir.Mode())
				}
			}
			// fs.writeFile preserves the permissions of an existing destination.
			existing := filepath.Join(root, "existing")
			check(os.WriteFile(existing, []byte("old"), 0600))
			write(existing, []byte("new"))
			info, err := os.Stat(existing)
			check(err)
			if info.Mode().Perm() != 0600 {
				t.Fatal("existing mode changed", info.Mode())
			}
		}()
	}
}
