// Package b declares the same interface name as its sibling module, with a different implementer set.
package b

// Storage is implemented by Gamma alone.
type Storage interface {
	Hold()
}

// Gamma satisfies Storage implicitly.
type Gamma struct{}

func (Gamma) Hold() {}
