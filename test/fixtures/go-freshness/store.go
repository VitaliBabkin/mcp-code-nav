// Package gofresh is copied into a temp directory before a test edits it: the freshness checks change
// the module on disk while a session holds it, and a checked-in fixture is never edited in place.
package gofresh

// Sink is satisfied by anything that can take a value.
type Sink interface {
	Take(value string)
}

// ChannelSink satisfies Sink without naming it.
type ChannelSink struct {
	fed string
}

func (c *ChannelSink) Take(value string) {
	c.fed = value
}
