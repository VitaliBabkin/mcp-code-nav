package fiximpl

// Reporter is structurally the predeclared error interface, so every error type in the packages gopls
// has loaded satisfies it: the fan-out the row cap exists to bound.
type Reporter interface {
	Error() string
}

// reportError is this module's own Reporter, so a capped answer still holds an in-module row.
type reportError struct {
	message string
}

func (r reportError) Error() string {
	return r.message
}

// NewReport hands the field a reader, keeping the type reachable from outside this module.
func NewReport(message string) Reporter {
	return reportError{message: message}
}
