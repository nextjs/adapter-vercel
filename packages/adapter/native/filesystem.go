package main

import "os"

func isSymlink(path string, mode os.FileMode) bool {
	if mode&os.ModeSymlink != 0 {
		return true
	}
	// Go 1.23+ classifies Windows junctions as irregular files. Node treats
	// them as links; Readlink distinguishes them from other irregular files.
	if mode&os.ModeIrregular != 0 {
		_, err := os.Readlink(path)
		return err == nil
	}
	return false
}
