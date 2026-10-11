package gonav

// hidden is never exported; its method Ping is. That is the pair the visibility answer reads — the name,
// not the receiver type — and the pair whose cross-package use stands in `sub`.
type hidden struct{}

// Ping is an exported method of an unexported type.
func (h *hidden) Ping() string { return "ping" }

// ping is unexported, so no identifier outside this package can denote it.
func (h *hidden) ping() string { return "ping" }

// NewHidden hands an importer a value whose exported method it can then call.
func NewHidden() *hidden { return &hidden{} }

// pingTwice is the only use of the unexported method.
func pingTwice() string { return NewHidden().ping() }

// Gauge is exported and carries an unexported method, the mirror case.
type Gauge struct{}

// sample is the method the sealed interface lists.
func (g *Gauge) sample() int { return 0 }

// Total is the only selector that names sample in this module.
func (g *Gauge) Total() int { return g.sample() }

// sealed can be satisfied outside this package only by embedding a type declared here.
type sealed interface{ sample() int }

// Use accepts anything sealed, including a wrapper that names no method at all.
func Use(s sealed) {}

// cache is the generic unexported type: `cache.Load` addresses its method by the base type name.
type cache[K comparable, V any] struct{}

// Load answers with the zero value of V, naming no other fixture symbol.
func (c *cache[K, V]) Load(k K) V {
	var zero V
	return zero
}

// NewCache gives an importer a value of the unexported generic type.
func NewCache[K comparable, V any]() *cache[K, V] {
	return &cache[K, V]{}
}
