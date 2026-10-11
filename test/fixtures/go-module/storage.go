// Package fixture is the module the live tests run against: one interface, one struct that
// satisfies it without naming it, and one method on that struct.
package fixture

// Storage is implemented by MemoryStorage below, implicitly.
type Storage interface {
	Get(key string) []byte
	Put(key string, value []byte)
}

// MemoryStorage satisfies Storage; nothing here names the interface, so no text matcher can either.
type MemoryStorage struct {
	data map[string][]byte
}

func (m *MemoryStorage) Get(key string) []byte {
	if m.data == nil {
		return nil
	}
	return m.data[key]
}

func (m *MemoryStorage) Put(key string, value []byte) {
	if m.data == nil {
		m.data = map[string][]byte{}
	}
	m.data[key] = value
}

// Default is a top-level function, so the outline must not lose it behind the types.
func Default() Storage {
	return &MemoryStorage{}
}
