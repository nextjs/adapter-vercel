package main

import "os"

type cloneResult uint8

const (
	cloneUnsupported cloneResult = iota
	cloneWritten
	cloneExisting
)

func cloneConfigFile(source, target string, clone func(*os.File, *os.File) (bool, error)) (cloneResult, error) {
	in, err := os.Open(source)
	if err != nil {
		return cloneUnsupported, err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if os.IsExist(err) {
		return cloneExisting, nil
	}
	if err != nil {
		return cloneUnsupported, err
	}
	cloned, cloneErr := clone(out, in)
	closeErr := out.Close()
	if !cloned || cloneErr != nil || closeErr != nil {
		removeErr := os.Remove(target)
		for _, err := range []error{cloneErr, closeErr, removeErr} {
			if err != nil {
				return cloneUnsupported, err
			}
		}
		return cloneUnsupported, nil
	}
	return cloneWritten, nil
}
