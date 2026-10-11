// Package wsa declares the interface a workspace-wide view would answer for. The implementer in the
// sibling module names nothing from here, because satisfaction in Go is structural.
package wsa

// Storage is satisfied by LocalSink in this module and by wsb.SiblingSink in the workspace's other one.
type Storage interface {
	Hold()
}

// LocalSink satisfies Storage inside this module.
type LocalSink struct{}

func (LocalSink) Hold() {}
