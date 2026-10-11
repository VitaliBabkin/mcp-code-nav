package fiximpl

import "io"

// Reader is an alias for a stdlib interface. Which direction a query about it takes is decided by the
// kind gopls reports for the alias itself, so the live test asserts what came back rather than assuming.
type Reader = io.Reader
