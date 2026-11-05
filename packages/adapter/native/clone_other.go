//go:build !linux

package main

import "os"

func cloneContents(destination, source *os.File) (bool, error) { return false, nil }
