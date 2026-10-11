package fiximpl

// LinuxStorage satisfies Storage too, but only when the toolchain's GOOS is linux: the `_linux.go`
// filename suffix is itself a build constraint, so on a windows host this type is not in the package
// graph at all and no answer computed here can contain it.
type LinuxStorage struct {
	directory string
}

func (l LinuxStorage) Get(key string) []byte {
	return []byte(l.directory + key)
}

func (l LinuxStorage) Put(key string, value []byte) {
	l.directory = string(value)
}
