package main

import (
	"os"
	"runtime"
	"syscall"
)

// FICLONE is _IOW(0x94, 9, int) in Linux's include/uapi/linux/fs.h.
// Unlike hard links, cloned files have independent inodes and edits.
func cloneContents(destination, source *os.File) (bool, error) {
	const ficlone = 0x40049409
	for {
		_, _, err := syscall.Syscall(syscall.SYS_IOCTL, destination.Fd(), ficlone, source.Fd())
		runtime.KeepAlive(destination)
		runtime.KeepAlive(source)
		switch err {
		case 0:
			return true, nil
		case syscall.EINTR:
			continue
		case syscall.EOPNOTSUPP, syscall.ENOTTY, syscall.ENOSYS, syscall.EXDEV, syscall.EINVAL, syscall.EBADF, syscall.EPERM, syscall.EACCES:
			return false, nil
		default:
			return false, err
		}
	}
}
