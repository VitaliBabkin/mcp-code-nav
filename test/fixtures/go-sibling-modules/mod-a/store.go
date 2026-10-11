// Package a declares the same interface name as its sibling module, with its own implementers. A query
// rooted in this module must answer for this module alone.
package a

// Storage is implemented by Alpha and Beta.
type Storage interface {
	Hold()
}

// Alpha satisfies Storage implicitly.
type Alpha struct{}

func (Alpha) Hold() {}

// Beta satisfies Storage implicitly.
type Beta struct{}

func (Beta) Hold() {}
