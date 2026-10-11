package sub

import "example.com/mcpcodenav/gonav"

// Ping calls an exported method of a type the module never exports, through a value its exported
// constructor handed out: an occurrence of that identifier in another package.
func Ping() string {
	return gonav.NewHidden().Ping()
}

// Wrapped promotes Gauge's methods, so it satisfies gonav.sealed without naming `sample` anywhere here.
type Wrapped struct {
	*gonav.Gauge
}

// Sealed is where that embedding is exercised.
func Sealed() {
	gonav.Use(Wrapped{})
}

// LoadValue shares its name with a declaration in package gonav. Two packages of one module declaring one
// name is the case the module-wide declaration search answers with two rows, so neither name is a guess.
func LoadValue() int {
	return 0
}
