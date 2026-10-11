package gonav

// Cache is generic over two parameters, so its method's outline name carries a parameter list: the type a
// caller names is still `Cache`, and `Cache.Get` is the spelling that reaches it.
type Cache[K comparable, V any] struct {
	values map[K]V
}

// Get reads one value, naming no other fixture symbol.
func (c *Cache[K, V]) Get(key K) V {
	return c.values[key]
}

// LoadValue is the one use of Cache.Get, and the only call site the reference answer carries.
func LoadValue(c *Cache[string, int]) int {
	return c.Get("hits")
}

// Index is an unrelated generic type with a Get of its own: two methods whose outline names differ only in
// the receiver's type name, which is what a receiver read that stopped at the wrong bracket would collapse.
type Index[K comparable, V any] struct {
	positions map[K]V
}

// Get reads one position.
func (i *Index[K, V]) Get(key K) V {
	return i.positions[key]
}
