// Package gonav is the module the live reference and caller tests ask gopls about: one package-private
// helper used from two files, an exported type used inside the module, a method reached both directly and
// through an interface value, and a helper nobody uses.
package gonav

import "fmt"

// Reader is the storage interface the service reads through.
type Reader interface {
	Read(id string) ([]byte, error)
}

// Memory satisfies Reader implicitly; nothing here names Reader in a base-specifier position.
type Memory struct {
	data map[string][]byte
}

// Read returns what is stored under the normalised id. Its call to normaliseKey is one of that helper's
// three uses, and the one in this file.
func (m *Memory) Read(id string) ([]byte, error) {
	key := normaliseKey(id)
	value, ok := m.data[key]
	if !ok {
		return nil, fmt.Errorf("no value for %q", key)
	}
	return value, nil
}

// normaliseKey is package-private and used from two files, so a reference answer about it is complete:
// Go forbids a reference to it from outside this package.
func normaliseKey(key string) string {
	if key == "" {
		return "default"
	}
	return key
}

// loneHelper is referenced nowhere, which is the zero-reference case: a scoped empty, not a failure.
func loneHelper() string {
	return "never used"
}

// Disk is a sibling implementation of Reader. `FetchDisk`, which names only (*Disk).Read, must stay out of
// (*Memory).Read's callers: that absence is the extent of gopls's correspondence.
type Disk struct{}

// Read satisfies Reader from Disk's side and calls no other fixture symbol.
func (d *Disk) Read(id string) ([]byte, error) {
	return nil, nil
}
