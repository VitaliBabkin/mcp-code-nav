package gonav

import "strings"

// Serve reads through the Reader interface: gopls's call hierarchy reports this call site against
// (*Memory).Read through the interface method Reader.Read.
func Serve(r Reader, id string) ([]byte, error) {
	return r.Read(id)
}

// Fetch calls (*Memory).Read directly, which is the static call edge a call hierarchy does resolve.
func Fetch(m *Memory, id string) ([]byte, error) {
	return m.Read(id)
}

// Trim normalises through the package-private helper from a second file, which is what makes that
// helper's reference answer span two files.
func Trim(key string) string {
	return strings.TrimSpace(normaliseKey(key))
}

// Store is exported and holds values under normalised keys.
type Store struct {
	items map[string][]byte
}

// Get reads one value.
func (s *Store) Get(key string) []byte {
	return s.items[normaliseKey(key)]
}

// FetchDisk calls (*Disk).Read directly, which is the other implementation of the interface `Serve`
// dispatches through.
func FetchDisk(d *Disk, id string) ([]byte, error) {
	return d.Read(id)
}
