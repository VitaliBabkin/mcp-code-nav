// Package wsb imports nothing from the sibling module: a gopls that spanned the workspace would still
// report SiblingSink as an implementation of wsa.Storage, which is what `GOWORK=off` is there to prevent.
package wsb

// SiblingSink satisfies wsa.Storage structurally, without that interface ever being named here.
type SiblingSink struct{}

func (SiblingSink) Hold() {}
