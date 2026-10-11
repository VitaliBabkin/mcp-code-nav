// Package fiximpl is the module the live implementation tests ask gopls about: one interface with an
// implementer that never names it, the kinds that give a direction, and the kinds
// it refuses.
package fiximpl

// Storage is satisfied by MemoryStorage below without that interface's name ever appearing in it.
type Storage interface {
	Get(key string) []byte
	Put(key string, value []byte)
}

// MemoryStorage satisfies Storage implicitly.
type MemoryStorage struct {
	data map[string][]byte
}

func (m MemoryStorage) Get(key string) []byte {
	if m.data == nil {
		return nil
	}
	return m.data[key]
}

func (m MemoryStorage) Put(key string, value []byte) {
	if m.data == nil {
		m.data = map[string][]byte{}
	}
	m.data[key] = value
}

// Lone is satisfied by nothing here, so a query about it is a proven scoped empty.
type Lone interface {
	NeverImplementedAnywhere()
}

// Helper is a func: gopls reports a real func and a named func type identically in an outline, so the
// direction of the question cannot be decided from it.
func Helper() {}

// Table is a package-level variable, which has no direction at all.
var Table = map[string]string{"key": "value"}

// Version is a package-level constant, which has no direction at all.
const Version = "1.0.0"
