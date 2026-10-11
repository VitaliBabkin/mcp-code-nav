package fiximpl

// The blank imports widen the package graph gopls loads for this module, so the structural query in
// reporter.go has an answer large enough to reach the row cap on any host.
import (
	_ "crypto/tls"
	_ "database/sql"
	_ "encoding/json"
	_ "net/http"
	_ "os"
)
