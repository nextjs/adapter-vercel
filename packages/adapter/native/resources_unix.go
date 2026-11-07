//go:build !windows

package main

import "syscall"

func startupResources() object {
	var usage syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) != nil {
		return nil
	}
	return object{"userMs": float64(usage.Utime.Sec)*1000 + float64(usage.Utime.Usec)/1000, "systemMs": float64(usage.Stime.Sec)*1000 + float64(usage.Stime.Usec)/1000, "majorFaults": usage.Majflt, "minorFaults": usage.Minflt, "inputBlocks": usage.Inblock, "voluntarySwitches": usage.Nvcsw, "involuntarySwitches": usage.Nivcsw}
}
